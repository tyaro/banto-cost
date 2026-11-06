// @vitest-environment jsdom
/**
 * @banto/ui toast contracts (docs/adr/0018-shared-ui-package.md §8, phase 2c):
 * the store (push / dismiss / auto-dismiss timing / replace-by-id / queue
 * limit / the action wrapper) and ToastHost (kind -> live region, close and
 * action buttons, text override). Look and the slide-in are browser
 * behaviour (e2e/visual), not asserted here.
 *
 * Timers are faked; after advancing them `flushSync()` lets the DOM catch up.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createToastStore,
	DEFAULT_TOAST_DURATION_MS,
	defaultUiMessages,
	ToastHost,
	type ToastKind
} from '../src/index';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const advance = (ms: number) => {
	vi.advanceTimersByTime(ms);
	flushSync();
};

const messagesOf = (store: ReturnType<typeof createToastStore>) =>
	store.toasts.map((toast) => toast.message);

describe('createToastStore: push / dismiss', () => {
	it('appends in order, returns the id and keeps kind and message', () => {
		const store = createToastStore();
		const a = store.push('success', 'one');
		const b = store.push('error', 'two');
		expect(a).not.toBe(b);
		expect(store.toasts.map((toast) => [toast.id, toast.kind, toast.message])).toEqual([
			[a, 'success', 'one'],
			[b, 'error', 'two']
		]);
	});

	it('dismiss removes only that toast; an unknown id is ignored', () => {
		const store = createToastStore();
		const a = store.push('info', 'one');
		store.push('info', 'two');
		store.dismiss('does-not-exist');
		expect(store.toasts).toHaveLength(2);
		store.dismiss(a);
		expect(messagesOf(store)).toEqual(['two']);
	});
});

describe('createToastStore: auto-dismiss', () => {
	it('defaults to 4000 ms (admin-template timing)', () => {
		expect(DEFAULT_TOAST_DURATION_MS).toBe(4000);
		const store = createToastStore();
		store.push('info', 'x');
		vi.advanceTimersByTime(3999);
		expect(store.toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(store.toasts).toHaveLength(0);
	});

	it('honours a per-toast durationMs and the store-wide autoDismissMs', () => {
		const store = createToastStore({ autoDismissMs: 1000 });
		store.push('info', 'default');
		store.push('info', 'long', { durationMs: 5000 });
		vi.advanceTimersByTime(1000);
		expect(messagesOf(store)).toEqual(['long']);
		vi.advanceTimersByTime(4000);
		expect(store.toasts).toHaveLength(0);
	});

	it.each([0, -1, Infinity])(
		'durationMs %s keeps the toast until it is dismissed',
		(durationMs) => {
			const store = createToastStore();
			const id = store.push('info', 'sticky', { durationMs });
			vi.advanceTimersByTime(60 * 60 * 1000);
			expect(store.toasts).toHaveLength(1);
			store.dismiss(id);
			expect(store.toasts).toHaveLength(0);
		}
	);

	it('counter: a dismissed toast`s timer does not dismiss a later toast that reuses the id', () => {
		const store = createToastStore();
		store.push('info', 'first', { id: 'k' });
		store.dismiss('k');
		store.push('info', 'second', { id: 'k', durationMs: 10_000 });
		vi.advanceTimersByTime(4000);
		expect(messagesOf(store)).toEqual(['second']);
	});

	it('counter: a generated id never collides with a caller-supplied id', () => {
		const store = createToastStore();
		store.push('info', 'first', { id: 'toast-1' });
		const generated = store.push('info', 'second');
		expect(generated).not.toBe('toast-1');
		expect(messagesOf(store)).toEqual(['first', 'second']);
		vi.advanceTimersByTime(3999); // the first toast's own timer is intact
		expect(messagesOf(store)).toEqual(['first', 'second']);
		vi.advanceTimersByTime(1);
		expect(store.toasts).toHaveLength(0);
	});

	it('pushing an existing id replaces the toast in place and restarts its timer', () => {
		const store = createToastStore();
		store.push('info', 'a');
		store.push('info', 'first', { id: 'k' });
		store.push('info', 'b');
		vi.advanceTimersByTime(3000);
		store.push('error', 'second', { id: 'k' });
		expect(store.toasts.map((toast) => [toast.id, toast.kind, toast.message])).toEqual([
			['toast-1', 'info', 'a'],
			['k', 'error', 'second'],
			['toast-2', 'info', 'b']
		]);
		vi.advanceTimersByTime(3000); // the old timer would have fired here
		expect(messagesOf(store)).toEqual(['second']);
		vi.advanceTimersByTime(1000);
		expect(store.toasts).toHaveLength(0);
	});
});

describe('createToastStore: maxToasts', () => {
	it('has no limit by default', () => {
		const store = createToastStore();
		for (let i = 0; i < 50; i++) store.push('info', `m${i}`);
		expect(store.toasts).toHaveLength(50);
	});

	it('dismisses the oldest when the limit is exceeded, and cancels its timer', () => {
		const store = createToastStore({ maxToasts: 2 });
		store.push('info', 'one', { id: 'one' });
		store.push('info', 'two');
		store.push('info', 'three');
		expect(messagesOf(store)).toEqual(['two', 'three']);
		// A new toast reusing the evicted id must not be hit by the evicted timer.
		store.push('info', 'one again', { id: 'one', durationMs: 10_000 });
		vi.advanceTimersByTime(4000);
		expect(messagesOf(store)).toEqual(['one again']);
	});
});

describe('createToastStore: action', () => {
	it('onAction runs the handler and then dismisses the toast', () => {
		const store = createToastStore();
		const onAction = vi.fn(() => {
			// still shown while the handler runs
			expect(store.toasts).toHaveLength(1);
		});
		store.push('info', 'deleted', { action: { label: 'Undo', onAction } });
		const action = store.toasts[0].action!;
		expect(action.label).toBe('Undo');
		action.onAction();
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(store.toasts).toHaveLength(0);
	});

	it('counter: dismisses even when the handler throws, and the error propagates', () => {
		const store = createToastStore();
		store.push('info', 'x', {
			action: {
				label: 'Undo',
				onAction: () => {
					throw new Error('boom');
				}
			}
		});
		expect(() => store.toasts[0].action!.onAction()).toThrow('boom');
		expect(store.toasts).toHaveLength(0);
	});

	it('counter: the handler does not run again after the toast is gone (double click, timer)', () => {
		const store = createToastStore();
		const onAction = vi.fn();
		store.push('info', 'x', { action: { label: 'Undo', onAction } });
		const action = store.toasts[0].action!;
		action.onAction();
		action.onAction();
		expect(onAction).toHaveBeenCalledTimes(1);

		store.push('info', 'y', { action: { label: 'Undo', onAction } });
		const late = store.toasts[0].action!;
		vi.advanceTimersByTime(4000);
		late.onAction();
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('counter: a stale action after dismiss + id reuse does not run the old handler or dismiss the new toast', () => {
		const store = createToastStore();
		const oldHandler = vi.fn();
		const newHandler = vi.fn();
		store.push('info', 'old', { id: 'k', action: { label: 'Undo', onAction: oldHandler } });
		const stale = store.toasts[0].action!;
		store.dismiss('k');
		store.push('info', 'new', { id: 'k', action: { label: 'Undo', onAction: newHandler } });
		stale.onAction();
		expect(oldHandler).not.toHaveBeenCalled();
		expect(newHandler).not.toHaveBeenCalled();
		expect(messagesOf(store)).toEqual(['new']);
	});

	it('counter: a stale action after in-place replacement does not run and the new toast stays', () => {
		const store = createToastStore();
		const oldHandler = vi.fn();
		store.push('info', 'old', { id: 'k', action: { label: 'Undo', onAction: oldHandler } });
		const stale = store.toasts[0].action!;
		store.push('info', 'new', { id: 'k' });
		stale.onAction();
		expect(oldHandler).not.toHaveBeenCalled();
		expect(messagesOf(store)).toEqual(['new']);
	});

	it('counter: a handler that updates the same id keeps the updated toast (also when it throws)', () => {
		for (const fail of [false, true]) {
			const store = createToastStore();
			store.push('info', 'working', {
				id: 'k',
				action: {
					label: 'Go',
					onAction: () => {
						store.push('success', 'done', { id: 'k' });
						if (fail) throw new Error('boom');
					}
				}
			});
			const action = store.toasts[0].action!;
			if (fail) expect(() => action.onAction()).toThrow('boom');
			else action.onAction();
			expect(messagesOf(store)).toEqual(['done']);
		}
	});

	it('counter: a timer of a replaced instance cannot dismiss the replacement', () => {
		const store = createToastStore();
		store.push('info', 'old', { id: 'k', durationMs: 1000 });
		store.push('info', 'new', { id: 'k', durationMs: 0 });
		vi.advanceTimersByTime(5000);
		expect(messagesOf(store)).toEqual(['new']);
	});

	it('a toast without an action has none', () => {
		const store = createToastStore();
		store.push('info', 'x');
		expect(store.toasts[0].action).toBeUndefined();
	});
});

describe('ToastHost', () => {
	const alertRegion = () => screen.getByRole('alert');
	const statusRegion = () => screen.getByRole('status');

	it('renders both live regions persistently, empty at first', () => {
		render(ToastHost, { store: createToastStore() });
		expect(statusRegion().getAttribute('aria-live')).toBe('polite');
		expect(alertRegion().getAttribute('aria-live')).toBe('assertive');
		expect(statusRegion().textContent?.trim()).toBe('');
		expect(alertRegion().textContent?.trim()).toBe('');
	});

	it.each<[ToastKind, 'status' | 'alert']>([
		['success', 'status'],
		['info', 'status'],
		['error', 'alert'],
		['warning', 'alert']
	])('a %s toast is announced in the %s region', (kind, role) => {
		const store = createToastStore();
		render(ToastHost, { store });
		store.push(kind, `msg-${kind}`);
		flushSync();
		const region = role === 'status' ? statusRegion() : alertRegion();
		const other = role === 'status' ? alertRegion() : statusRegion();
		expect(within(region).getByText(`msg-${kind}`)).toBeTruthy();
		expect(within(other).queryByText(`msg-${kind}`)).toBeNull();
		expect(region.querySelector('.toast')?.getAttribute('data-kind')).toBe(kind);
	});

	it('a toast disappears from the DOM when its timer fires', () => {
		const store = createToastStore();
		render(ToastHost, { store });
		store.push('success', 'saved');
		flushSync();
		expect(screen.queryByText('saved')).not.toBeNull();
		advance(4000);
		expect(screen.queryByText('saved')).toBeNull();
	});

	it('the close button has the default accessible name and dismisses', async () => {
		const store = createToastStore();
		render(ToastHost, { store });
		store.push('info', 'hello');
		flushSync();
		await fireEvent.click(screen.getByRole('button', { name: defaultUiMessages.toastClose() }));
		expect(screen.queryByText('hello')).toBeNull();
		expect(store.toasts).toHaveLength(0);
	});

	it('messages.toastClose overrides the close button name', () => {
		const store = createToastStore();
		render(ToastHost, { store, messages: { toastClose: () => 'Dismiss' } });
		store.push('info', 'hello');
		flushSync();
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: defaultUiMessages.toastClose() })).toBeNull();
	});

	it('the action button is focusable, runs the handler once and removes the toast', async () => {
		const store = createToastStore();
		const onAction = vi.fn();
		render(ToastHost, { store });
		const id = store.push('info', 'Tag deleted', { action: { label: 'Undo', onAction } });
		flushSync();
		const button = screen.getByRole('button', { name: 'Undo' });
		expect(button.getAttribute('data-testid')).toBe(`toast-action-${id}`);
		button.focus();
		expect(document.activeElement).toBe(button);
		await fireEvent.click(button);
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Tag deleted')).toBeNull();
	});

	it('no action button unless the toast has an action', () => {
		const store = createToastStore();
		render(ToastHost, { store });
		store.push('info', 'plain');
		flushSync();
		expect(screen.getAllByRole('button')).toHaveLength(1); // the close button only
	});

	it('counter: an error toast is not announced in the polite region', () => {
		const store = createToastStore();
		render(ToastHost, { store });
		store.push('error', 'failed');
		flushSync();
		expect(within(statusRegion()).queryByText('failed')).toBeNull();
	});
});
