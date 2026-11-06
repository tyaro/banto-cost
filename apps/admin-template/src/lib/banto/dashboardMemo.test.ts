/**
 * The dashboard メモ pane's wiring (dashboardMemo.svelte.ts,
 * shared-primitives-upstream-plan §3.5・D9, Issue #432 PR-10): the dock
 * lifecycle → coordinator table, which settle results may discard the pane,
 * and the page-owned draft + saved setting against a provider whose save can
 * be held open. The DOM side (dock / undock / close in the real dashboard) is
 * the e2e scenario `13l` in `e2e/tests/smoke.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { UiSettingsProvider } from '@banto/admin-core';
import type { DraftSettleResult } from '@banto/forms';
import {
	MEMO_FIELD,
	MEMO_PANEL_ID,
	MEMO_SAVE_COMMAND_ID,
	MEMO_SETTING_KEY,
	adoptStoredMemo,
	canDiscardAfterSettle,
	canSaveMemo,
	createDashboardMemo,
	createPanelChangeHandler,
	memoSaveCommand,
	memoText
} from './dashboardMemo.svelte';

function fakeCoordinator(result: DraftSettleResult = 'clean') {
	return {
		capture: vi.fn((_keys: readonly string[]) => {}),
		settle: vi.fn(
			async (
				_keys: readonly string[] | undefined,
				_ask: (k: readonly string[]) => Promise<'apply' | 'discard' | 'cancel'>
			) => result
		)
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A provider whose `set` calls wait until the test releases them. */
function heldProvider(stored: string | null = null) {
	const sets: { key: string; value: string; done: Deferred<void> }[] = [];
	const get = deferred<string | null>();
	const provider: UiSettingsProvider = {
		get: vi.fn(() => get.promise),
		set: vi.fn((key: string, value: string) => {
			const done = deferred<void>();
			sets.push({ key, value, done });
			return done.promise;
		})
	};
	return { provider, sets, resolveGet: () => get.resolve(stored) };
}

function memoWith(provider: UiSettingsProvider) {
	return createDashboardMemo({
		provider,
		label: 'memo',
		leaveMessage: () => 'leave?'
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('canDiscardAfterSettle', () => {
	it.each([
		['clean', true],
		['applied', true],
		['discarded', true],
		['cancelled', false],
		['failed', false],
		['dirty-again', false],
		['stale', false]
	] as const)('%s -> %s', (result, expected) => {
		expect(canDiscardAfterSettle(result)).toBe(expected);
	});
});

describe('createPanelChangeHandler (plan §3.5 transition table)', () => {
	it.each(['dock', 'undock', 'move-docked'] as const)(
		'%s captures the pane and goes ahead without asking',
		(kind) => {
			const coordinator = fakeCoordinator();
			const ask = vi.fn();
			const handler = createPanelChangeHandler({ coordinator, ask });
			expect(handler({ kind, panelId: MEMO_PANEL_ID, remount: true })).toBe(true);
			expect(coordinator.capture).toHaveBeenCalledWith([MEMO_PANEL_ID]);
			expect(coordinator.settle).not.toHaveBeenCalled();
			expect(ask).not.toHaveBeenCalled();
		}
	);

	it('a re-mounting tab switch captures the pane it leaves; one that keeps the DOM does nothing', () => {
		const coordinator = fakeCoordinator();
		const handler = createPanelChangeHandler({ coordinator, ask: vi.fn() });
		expect(
			handler({ kind: 'tab-switch', groupId: 'g', from: MEMO_PANEL_ID, to: 'x', remount: true })
		).toBe(true);
		expect(coordinator.capture).toHaveBeenCalledWith([MEMO_PANEL_ID]);
		coordinator.capture.mockClear();
		expect(
			handler({ kind: 'tab-switch', groupId: 'g', from: MEMO_PANEL_ID, to: 'x', remount: false })
		).toBe(true);
		expect(coordinator.capture).not.toHaveBeenCalled();
		expect(coordinator.settle).not.toHaveBeenCalled();
	});

	it('hide never asks', () => {
		const coordinator = fakeCoordinator();
		const handler = createPanelChangeHandler({ coordinator, ask: vi.fn() });
		expect(handler({ kind: 'hide', panelId: MEMO_PANEL_ID, remount: true })).toBe(true);
		expect(handler({ kind: 'hide', panelId: MEMO_PANEL_ID, remount: false })).toBe(true);
		expect(coordinator.capture).toHaveBeenCalledTimes(1);
		expect(coordinator.settle).not.toHaveBeenCalled();
	});

	it.each([
		['clean', true],
		['applied', true],
		['discarded', true],
		['cancelled', false],
		['failed', false],
		['dirty-again', false],
		['stale', false]
	] as const)('close settles that pane with the prompt: %s -> %s', async (result, expected) => {
		const coordinator = fakeCoordinator(result);
		const ask = vi.fn();
		const onSettled = vi.fn();
		const handler = createPanelChangeHandler({ coordinator, ask, onSettled });
		await expect(handler({ kind: 'close', panelId: MEMO_PANEL_ID })).resolves.toBe(expected);
		expect(coordinator.settle).toHaveBeenCalledWith([MEMO_PANEL_ID], ask);
		expect(coordinator.capture).not.toHaveBeenCalled();
		expect(onSettled).toHaveBeenCalledWith(MEMO_PANEL_ID, result);
	});
});

describe('createDashboardMemo', () => {
	it('close -> apply -> typing during the save: the save stores v1, the pane is kept and the draft stays dirty', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		const unregister = memo.register();
		const handler = createPanelChangeHandler({
			coordinator: memo.coordinator,
			ask: async () => 'apply'
		});

		memo.draft.setValue(MEMO_FIELD, 'v1');
		expect(memo.coordinator.pending).toBe(true);
		const closing = handler({ kind: 'close', panelId: MEMO_PANEL_ID });
		await flush();
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({ key: MEMO_SETTING_KEY, value: 'v1' });

		memo.draft.setValue(MEMO_FIELD, 'v1 v2');
		sets[0]!.done.resolve();
		await expect(closing).resolves.toBe(false);
		expect(memoText(memo.draft.values)).toBe('v1 v2');
		expect(memoText(memo.draft.baseline)).toBe('v1');
		expect(memo.draft.dirty).toBe(true);
		expect(memo.coordinator.pending).toBe(true);

		unregister();
		memo.dispose();
	});

	it('close -> apply that succeeds with nothing typed meanwhile closes', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const handler = createPanelChangeHandler({
			coordinator: memo.coordinator,
			ask: async () => 'apply'
		});
		memo.draft.setValue(MEMO_FIELD, 'saved');
		const closing = handler({ kind: 'close', panelId: MEMO_PANEL_ID });
		await flush();
		sets[0]!.done.resolve();
		await expect(closing).resolves.toBe(true);
		expect(memo.draft.dirty).toBe(false);
		memo.dispose();
	});

	it('a failed save keeps the pane and the input', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const handler = createPanelChangeHandler({
			coordinator: memo.coordinator,
			ask: async () => 'apply'
		});
		memo.draft.setValue(MEMO_FIELD, 'not saved');
		const closing = handler({ kind: 'close', panelId: MEMO_PANEL_ID });
		await flush();
		sets[0]!.done.reject(new Error('offline'));
		await expect(closing).resolves.toBe(false);
		expect(memoText(memo.draft.values)).toBe('not saved');
		expect(memo.draft.dirty).toBe(true);
		memo.dispose();
	});

	it('close -> discard closes and puts the draft back to its baseline without saving', async () => {
		const { provider } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const handler = createPanelChangeHandler({
			coordinator: memo.coordinator,
			ask: async () => 'discard'
		});
		memo.draft.setValue(MEMO_FIELD, 'throw away');
		await expect(handler({ kind: 'close', panelId: MEMO_PANEL_ID })).resolves.toBe(true);
		expect(memoText(memo.draft.values)).toBe('');
		expect(memo.draft.dirty).toBe(false);
		expect(provider.set).not.toHaveBeenCalled();
		memo.dispose();
	});

	it('close -> cancel keeps everything', async () => {
		const { provider } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const handler = createPanelChangeHandler({
			coordinator: memo.coordinator,
			ask: async () => 'cancel'
		});
		memo.draft.setValue(MEMO_FIELD, 'keep');
		await expect(handler({ kind: 'close', panelId: MEMO_PANEL_ID })).resolves.toBe(false);
		expect(memoText(memo.draft.values)).toBe('keep');
		expect(memo.draft.dirty).toBe(true);
		memo.dispose();
	});

	it('the dirty draft stays pending while the pane is gone (registered for the page, not the pane)', async () => {
		const { provider } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const handler = createPanelChangeHandler({ coordinator: memo.coordinator, ask: vi.fn() });
		memo.draft.setValue(MEMO_FIELD, 'unsaved');
		expect(handler({ kind: 'undock', panelId: MEMO_PANEL_ID, remount: true })).toBe(true);
		expect(handler({ kind: 'dock', panelId: MEMO_PANEL_ID, remount: true })).toBe(true);
		expect(memoText(memo.draft.values)).toBe('unsaved');
		expect(memo.coordinator.pending).toBe(true);
		memo.dispose();
		expect(memo.coordinator.pending).toBe(false);
	});

	it('the save button applies without a prompt and reports dirty-again for input typed meanwhile', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		memo.draft.setValue(MEMO_FIELD, 'a');
		const saving = memo.save();
		await flush();
		memo.draft.setValue(MEMO_FIELD, 'ab');
		sets[0]!.done.resolve();
		await expect(saving).resolves.toBe('dirty-again');
		expect(memoText(memo.draft.baseline)).toBe('a');
		memo.dispose();
	});

	it('load adopts the stored memo into an untouched draft', async () => {
		const { provider, resolveGet } = heldProvider('stored text');
		const memo = memoWith(provider);
		const loading = memo.load();
		resolveGet();
		await loading;
		expect(memoText(memo.draft.values)).toBe('stored text');
		expect(memo.draft.dirty).toBe(false);
		memo.dispose();
	});

	it('load keeps input typed before the stored memo arrived, against the stored baseline; discard goes back to it', async () => {
		const { provider, resolveGet } = heldProvider('stored text');
		const memo = memoWith(provider);
		memo.register();
		const loading = memo.load();
		memo.draft.setValue(MEMO_FIELD, 'typed first');
		resolveGet();
		await loading;
		expect(memoText(memo.draft.values)).toBe('typed first');
		expect(memoText(memo.draft.baseline)).toBe('stored text');
		expect(memo.draft.dirty).toBe(true);

		const handler = createPanelChangeHandler({
			coordinator: memo.serial,
			ask: async () => 'discard'
		});
		await expect(handler({ kind: 'close', panelId: MEMO_PANEL_ID })).resolves.toBe(true);
		expect(memoText(memo.draft.values)).toBe('stored text');
		memo.dispose();
	});

	it('a close during a save waits for it: nothing is asked or discarded, and it closes once the save landed', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const ask = vi.fn(async () => 'discard' as const);
		const handler = createPanelChangeHandler({ coordinator: memo.serial, ask });

		memo.draft.setValue(MEMO_FIELD, 'saving');
		const saving = memo.save();
		await flush();
		expect(sets).toHaveLength(1);
		const closing = handler({ kind: 'close', panelId: MEMO_PANEL_ID });
		await flush();
		expect(ask).not.toHaveBeenCalled();
		expect(memoText(memo.draft.values)).toBe('saving');

		sets[0]!.done.resolve();
		await expect(saving).resolves.toBe('applied');
		await expect(closing).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(memoText(memo.draft.baseline)).toBe('saving');
		expect(memo.draft.dirty).toBe(false);
		memo.dispose();
	});

	it('a close during a save asks only after it, about the input typed meanwhile; discard keeps the saved text as baseline', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const ask = vi.fn(async () => 'discard' as const);
		const handler = createPanelChangeHandler({ coordinator: memo.serial, ask });

		memo.draft.setValue(MEMO_FIELD, 'v1');
		const saving = memo.save();
		await flush();
		memo.draft.setValue(MEMO_FIELD, 'v1 v2');
		const closing = handler({ kind: 'close', panelId: MEMO_PANEL_ID });
		await flush();
		expect(ask).not.toHaveBeenCalled();

		sets[0]!.done.resolve();
		await expect(saving).resolves.toBe('dirty-again');
		await expect(closing).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(memoText(memo.draft.values)).toBe('v1');
		expect(memo.draft.dirty).toBe(false);
		memo.dispose();
	});
});

describe('adoptStoredMemo', () => {
	it('keeps an edit but moves the baseline to the stored value', () => {
		const memo = memoWith(heldProvider().provider);
		memo.draft.setValue(MEMO_FIELD, 'edit');
		expect(adoptStoredMemo(memo.draft, 'stored')).toBe(false);
		expect(memoText(memo.draft.values)).toBe('edit');
		expect(memoText(memo.draft.baseline)).toBe('stored');
		expect(memo.draft.dirty).toBe(true);
		memo.dispose();
	});

	it('an edit equal to the stored value ends clean', () => {
		const memo = memoWith(heldProvider().provider);
		memo.draft.setValue(MEMO_FIELD, 'same');
		expect(adoptStoredMemo(memo.draft, 'same')).toBe(true);
		expect(memo.draft.dirty).toBe(false);
		memo.dispose();
	});
});

// Issue #435 PR-11: the pane's save button and Ctrl+S share one command.
describe('memoSaveCommand', () => {
	function commandFor(memo: ReturnType<typeof memoWith>) {
		return memoSaveCommand({
			memo,
			title: 'save',
			shortcut: 'Mod+S',
			save: () => void memo.save()
		});
	}

	it('is taken inside the textarea and keeps the browser save page away even when disabled', () => {
		const memo = memoWith(heldProvider().provider);
		const command = commandFor(memo);
		expect(command).toMatchObject({
			id: MEMO_SAVE_COMMAND_ID,
			title: 'save',
			shortcut: 'Mod+S',
			allowInEditable: true,
			preventDefaultWhenDisabled: true
		});
		expect(command.allowRepeat).toBeUndefined();
		memo.dispose();
	});

	it('is enabled only with unapplied input and no save in flight (the button condition)', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const command = commandFor(memo);
		expect(command.enabled?.()).toBe(false);
		expect(canSaveMemo(memo)).toBe(false);

		memo.draft.setValue(MEMO_FIELD, 'typed');
		expect(command.enabled?.()).toBe(true);

		void command.run();
		await flush();
		expect(sets).toHaveLength(1);
		expect(command.enabled?.()).toBe(false);

		sets[0]!.done.resolve();
		await flush();
		expect(memo.draft.dirty).toBe(false);
		expect(command.enabled?.()).toBe(false);
		expect(provider.set).toHaveBeenCalledTimes(1);
		memo.dispose();
	});

	it('runs the serialized save: a close asked during it waits and then closes without asking', async () => {
		const { provider, sets } = heldProvider();
		const memo = memoWith(provider);
		memo.register();
		const ask = vi.fn(async () => 'discard' as const);
		const handler = createPanelChangeHandler({ coordinator: memo.serial, ask });
		const command = commandFor(memo);

		memo.draft.setValue(MEMO_FIELD, 'ctrl+s');
		void command.run();
		await flush();
		const closing = handler({ kind: 'close', panelId: MEMO_PANEL_ID });
		await flush();
		expect(ask).not.toHaveBeenCalled();

		sets[0]!.done.resolve();
		await expect(closing).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
		expect(memoText(memo.draft.baseline)).toBe('ctrl+s');
		memo.dispose();
	});
});
