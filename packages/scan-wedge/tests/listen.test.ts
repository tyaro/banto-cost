import { describe, expect, it, vi } from 'vitest';
import { listenWedge } from '../src/listen';

// This workspace's vitest config runs every package with `environment:
// 'node'` (see vite.config.ts) - no jsdom/happy-dom is installed anywhere
// in the monorepo, and adding one is out of scope here (see task notes: no
// new devDependencies beyond what @banto/attachments already uses). So
// instead of real DOM elements/events we hand-roll the minimal
// `EventTarget`-shaped stand-ins `listenWedge` actually touches:
// `addEventListener`/`removeEventListener` and a `keydown` event object
// with the fields the core cares about (`key`, `timeStamp`, ...) plus
// `preventDefault`/`target`. This still exercises the real `listen.ts`
// code (capture registration, forwarding into the core, preventDefault-on-
// scan, cleanup, ignoreEditable), just without a full DOM.

interface FakeTarget {
	addEventListener(type: string, handler: (event: unknown) => void): void;
	removeEventListener(type: string, handler: (event: unknown) => void): void;
	dispatch(type: string, event: unknown): void;
}

function createFakeTarget(): FakeTarget {
	const handlers = new Set<(event: unknown) => void>();
	return {
		addEventListener(_type, handler) {
			handlers.add(handler);
		},
		removeEventListener(_type, handler) {
			handlers.delete(handler);
		},
		dispatch(_type, event) {
			for (const handler of handlers) handler(event);
		}
	};
}

function keydown(key: string, timeStamp: number, overrides: Record<string, unknown> = {}) {
	return { type: 'keydown', key, timeStamp, target: null, preventDefault: vi.fn(), ...overrides };
}

function typeBurst(target: FakeTarget, code: string, startAt = 0, step = 10) {
	for (let i = 0; i < code.length; i++) {
		target.dispatch('keydown', keydown(code[i], startAt + i * step));
	}
}

describe('listenWedge', () => {
	it('forwards keydown events to the core and fires onScan on a completed scan', () => {
		const target = createFakeTarget();
		const onScan = vi.fn();
		listenWedge(target as unknown as HTMLElement, { onScan });

		typeBurst(target, 'ABCD', 0, 10);
		target.dispatch('keydown', keydown('Enter', 35));

		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
	});

	it('calls preventDefault on the terminator keystroke by default', () => {
		const target = createFakeTarget();
		listenWedge(target as unknown as HTMLElement, { onScan: vi.fn() });

		typeBurst(target, 'ABCD', 0, 10);
		const enterEvent = keydown('Enter', 35);
		target.dispatch('keydown', enterEvent);

		expect(enterEvent.preventDefault).toHaveBeenCalledTimes(1);
	});

	it('does not call preventDefault when preventTerminatorDefault is false', () => {
		const target = createFakeTarget();
		listenWedge(target as unknown as HTMLElement, {
			onScan: vi.fn(),
			preventTerminatorDefault: false
		});

		typeBurst(target, 'ABCD', 0, 10);
		const enterEvent = keydown('Enter', 35);
		target.dispatch('keydown', enterEvent);

		expect(enterEvent.preventDefault).not.toHaveBeenCalled();
	});

	it('does not call preventDefault for keystrokes that do not complete a scan', () => {
		const target = createFakeTarget();
		listenWedge(target as unknown as HTMLElement, { onScan: vi.fn() });

		const aEvent = keydown('A', 0);
		target.dispatch('keydown', aEvent);

		expect(aEvent.preventDefault).not.toHaveBeenCalled();
	});

	it('stops forwarding events once the returned cleanup function is called', () => {
		const target = createFakeTarget();
		const onScan = vi.fn();
		const stop = listenWedge(target as unknown as HTMLElement, { onScan });

		stop();
		typeBurst(target, 'ABCD', 0, 10);
		target.dispatch('keydown', keydown('Enter', 35));

		expect(onScan).not.toHaveBeenCalled();
	});

	describe('ignoreEditable', () => {
		// `isEditableTarget` in listen.ts does `target instanceof HTMLElement`,
		// which needs an `HTMLElement` global to exist even to evaluate to
		// `false`. Node has no such global by default, so this suite installs
		// a minimal stand-in class for the duration of these tests only
		// (not jsdom - just enough for `instanceof` to work).
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

		it('skips detection while an editable element has focus', () => {
			withFakeHTMLElement(() => {
				const input = Object.assign(new FakeHTMLElement(), { tagName: 'INPUT' });
				const target = createFakeTarget();
				const onScan = vi.fn();
				listenWedge(target as unknown as HTMLElement, { onScan, ignoreEditable: true });

				typeBurst(target, 'ABCD', 0, 10);
				target.dispatch('keydown', keydown('Enter', 35, { target: input }));

				expect(onScan).not.toHaveBeenCalled();
			});
		});

		it('still detects scans when the focused element is not editable', () => {
			withFakeHTMLElement(() => {
				const div = Object.assign(new FakeHTMLElement(), { tagName: 'DIV' });
				const target = createFakeTarget();
				const onScan = vi.fn();
				listenWedge(target as unknown as HTMLElement, { onScan, ignoreEditable: true });

				for (let i = 0; i < 'ABCD'.length; i++) {
					target.dispatch('keydown', keydown('ABCD'[i], i * 10, { target: div }));
				}
				target.dispatch('keydown', keydown('Enter', 35, { target: div }));

				expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
			});
		});
	});
});
