import { describe, expect, it, vi } from 'vitest';
import { wedgeInput, keepFocused } from '../src/actions';

// Same rationale as tests/listen.test.ts: this workspace runs vitest with
// `environment: 'node'` everywhere (no jsdom/happy-dom installed, and
// adding one is out of scope - see task notes). These actions are exercised
// against hand-rolled `EventTarget`-shaped stand-ins rather than real DOM
// nodes.

function createFakeInput() {
	const listeners = new Set<(event: unknown) => void>();
	return {
		value: '',
		addEventListener(_type: string, handler: (event: unknown) => void) {
			listeners.add(handler);
		},
		removeEventListener(_type: string, handler: (event: unknown) => void) {
			listeners.delete(handler);
		},
		dispatchEvent: vi.fn(),
		dispatch(event: unknown) {
			for (const handler of listeners) handler(event);
		}
	};
}

function keydown(key: string, timeStamp: number, overrides: Record<string, unknown> = {}) {
	return { type: 'keydown', key, timeStamp, target: null, preventDefault: vi.fn(), ...overrides };
}

function typeBurst(input: ReturnType<typeof createFakeInput>, code: string, step = 10) {
	for (let i = 0; i < code.length; i++) {
		input.dispatch(keydown(code[i], i * step));
	}
}

describe('wedgeInput', () => {
	it('calls onScan and clears the input, dispatching a bubbling input event, on a completed scan', () => {
		const input = createFakeInput();
		const onScan = vi.fn();
		wedgeInput(input as unknown as HTMLInputElement, { onScan });

		typeBurst(input, 'ABCD');
		input.dispatch(keydown('Enter', 35));

		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
		expect(input.value).toBe('');
		expect(input.dispatchEvent).toHaveBeenCalledTimes(1);
		const dispatched = input.dispatchEvent.mock.calls[0][0] as Event;
		expect(dispatched.type).toBe('input');
		expect(dispatched.bubbles).toBe(true);
	});

	it('does not clear the input when clearOnScan is false', () => {
		const input = createFakeInput();
		const onScan = vi.fn();
		wedgeInput(input as unknown as HTMLInputElement, { onScan, clearOnScan: false });
		input.value = 'ABCD';

		typeBurst(input, 'ABCD');
		input.dispatch(keydown('Enter', 35));

		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
		expect(input.value).toBe('ABCD');
		expect(input.dispatchEvent).not.toHaveBeenCalled();
	});

	it('update() swaps in the new onScan and drops the old listener', () => {
		const input = createFakeInput();
		const onScanFirst = vi.fn();
		const onScanSecond = vi.fn();
		const action = wedgeInput(input as unknown as HTMLInputElement, { onScan: onScanFirst });
		action?.update?.({ onScan: onScanSecond });

		typeBurst(input, 'ABCD');
		input.dispatch(keydown('Enter', 35));

		expect(onScanFirst).not.toHaveBeenCalled();
		expect(onScanSecond).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
	});

	it('destroy() stops forwarding keydown events', () => {
		const input = createFakeInput();
		const onScan = vi.fn();
		const action = wedgeInput(input as unknown as HTMLInputElement, { onScan });
		action?.destroy?.();

		typeBurst(input, 'ABCD');
		input.dispatch(keydown('Enter', 35));

		expect(onScan).not.toHaveBeenCalled();
	});
});

describe('keepFocused', () => {
	function createFakeElement() {
		const listeners = new Set<(event: unknown) => void>();
		return {
			focus: vi.fn(),
			addEventListener(_type: string, handler: (event: unknown) => void) {
				listeners.add(handler);
			},
			removeEventListener(_type: string, handler: (event: unknown) => void) {
				listeners.delete(handler);
			},
			dispatch(event: unknown) {
				for (const handler of listeners) handler(event);
			}
		};
	}

	function stubImmediateRaf() {
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		});
	}

	class FakeHTMLElement {
		tagName = '';
		isContentEditable = false;
	}

	function withFakeHTMLElement(run: () => void) {
		const original = (globalThis as Record<string, unknown>).HTMLElement;
		(globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
		try {
			run();
		} finally {
			(globalThis as Record<string, unknown>).HTMLElement = original;
		}
	}

	it('refocuses the element on blur when the new focus target is not editable', () => {
		stubImmediateRaf();
		try {
			withFakeHTMLElement(() => {
				const el = createFakeElement();
				keepFocused(el as unknown as HTMLElement, { enabled: true });

				el.dispatch({ type: 'blur', relatedTarget: null });

				expect(el.focus).toHaveBeenCalledTimes(1);
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('does not refocus when the new focus target is editable', () => {
		stubImmediateRaf();
		try {
			withFakeHTMLElement(() => {
				const el = createFakeElement();
				keepFocused(el as unknown as HTMLElement, { enabled: true });
				const otherInput = Object.assign(new FakeHTMLElement(), { tagName: 'INPUT' });

				el.dispatch({ type: 'blur', relatedTarget: otherInput });

				expect(el.focus).not.toHaveBeenCalled();
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('does not refocus when disabled', () => {
		stubImmediateRaf();
		try {
			const el = createFakeElement();
			keepFocused(el as unknown as HTMLElement, { enabled: false });

			el.dispatch({ type: 'blur', relatedTarget: null });

			expect(el.focus).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('update() can disable a previously-enabled instance', () => {
		stubImmediateRaf();
		try {
			const el = createFakeElement();
			const action = keepFocused(el as unknown as HTMLElement, { enabled: true });
			action?.update?.({ enabled: false });

			el.dispatch({ type: 'blur', relatedTarget: null });

			expect(el.focus).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('destroy() removes the blur listener', () => {
		stubImmediateRaf();
		try {
			const el = createFakeElement();
			const action = keepFocused(el as unknown as HTMLElement, { enabled: true });
			action?.destroy?.();

			el.dispatch({ type: 'blur', relatedTarget: null });

			expect(el.focus).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
