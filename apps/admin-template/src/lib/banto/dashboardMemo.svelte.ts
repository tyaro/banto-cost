/**
 * The dashboard's メモ pane (shared-primitives-upstream-plan §3.5・D9, Issue
 * #432 PR-10): unapplied input that survives the dock's structure changes,
 * and the wiring between `@banto/forms`' draft and `@banto/dock-svelte`'s
 * lifecycle hook (plan §4.2). The two packages never import each other
 * (plan §2.1); the app joins them here.
 *
 * Lifetimes (forms README「pane より長生きする draft」):
 *  - the `FormDraft`, the `DraftCoordinator` and the saved setting belong to
 *    the PAGE. The draft's source is registered for the page's lifetime, not
 *    the pane's: a closed / re-mounting pane leaves its dirty draft pending,
 *    so a router leave still asks about it.
 *  - the pane (`DashboardMemoField.svelte`) only draws the field from the
 *    draft; it is re-created on every dock / undock / tab switch.
 *
 * Apply = store the text through the existing `UiSettingsProvider` under
 * {@link MEMO_SETTING_KEY} (spec §12.1 / M12: per-user settings DB via REST or
 * Tauri - both reach the same `SettingsService::ui_set`, conventions §1 -
 * and localStorage in demo mode), through admin-core's `createSavedSetting`
 * (serialized saves, late answers after `dispose()` ignored, #437).
 *
 * No Paraglide import here: every visible string comes in resolved
 * (conventions §13), which also keeps this module testable in the node
 * vitest environment.
 */
import { createSavedSetting, type SavedSetting, type UiSettingsProvider } from '@banto/admin-core';
import {
	createDraftCoordinator,
	createFormDraft,
	draftSourceFrom,
	type DraftCoordinator,
	type DraftSettleChoice,
	type DraftSettleResult,
	type FormDraft,
	type FormSchema,
	type ValidationMessages
} from '@banto/forms';
import type { DockPanelChange } from '@banto/dock-svelte';
import type { CommandSpec } from '@banto/ui';

/** The dock panel id; also the draft's key (one draft per pane). */
export const MEMO_PANEL_ID = 'memo';
/** UiSettingsProvider key (`[A-Za-z0-9._-]{1,64}`, spec M12). */
export const MEMO_SETTING_KEY = 'dashboard.memo';
/** The draft's only field. */
export const MEMO_FIELD = 'memo';
/** Length bound of the text (well under the backend's 64KB per value). */
export const MEMO_MAX_LENGTH = 2000;

/** The consumer's apply / discard / cancel prompt (one per settle). */
export type SettleAsk = (dirtyKeys: readonly string[]) => Promise<DraftSettleChoice>;

export function memoSchema(label: string): FormSchema {
	return {
		fields: [{ name: MEMO_FIELD, label, type: 'textarea', max: MEMO_MAX_LENGTH }]
	};
}

/**
 * May the pane's content be thrown away after `settle`? Only when every
 * target is clean at that moment (plan §3.5): `cancelled`, `failed`,
 * `dirty-again` (input typed while the apply was in flight) and `stale` keep it.
 * A successful apply alone is not the condition.
 */
export function canDiscardAfterSettle(result: DraftSettleResult): boolean {
	return result === 'clean' || result === 'applied' || result === 'discarded';
}

export interface PanelChangeHandlerOptions {
	coordinator: Pick<DraftCoordinator, 'capture' | 'settle'>;
	ask: SettleAsk;
	/** Told every `close` settle's result (e.g. to explain why the pane stayed). */
	onSettled?: (panelId: string, result: DraftSettleResult) => void;
}

/**
 * `DockHost.beforePanelChange`, transition by transition (plan §3.5's table):
 *  - `dock` / `undock` / `move-docked`, and `tab-switch` / `hide` that
 *    re-mount: `capture` the pane's draft and go ahead, no prompt. (A
 *    `FormDraft` source has no `capture`, so this is a no-op for the memo -
 *    its draft outlives the pane anyway - but a pane-owned `DraftSource`
 *    would be rebound on its next `register`.)
 *  - `tab-switch` / `hide` that keep the DOM (`remount: false`): nothing.
 *  - `close` (the content is discarded): `settle` with the prompt; only
 *    `clean` / `applied` / `discarded` let it close.
 */
export function createPanelChangeHandler(
	options: PanelChangeHandlerOptions
): (change: DockPanelChange) => boolean | Promise<boolean> {
	const { coordinator, ask, onSettled } = options;
	return (change) => {
		switch (change.kind) {
			case 'close':
				return coordinator.settle([change.panelId], ask).then((result) => {
					onSettled?.(change.panelId, result);
					return canDiscardAfterSettle(result);
				});
			case 'tab-switch':
				if (change.remount) coordinator.capture([change.from]);
				return true;
			case 'hide':
				if (change.remount) coordinator.capture([change.panelId]);
				return true;
			default:
				coordinator.capture([change.panelId]);
				return true;
		}
	};
}

/**
 * Make a stored value the draft's baseline. An untouched draft also shows it;
 * a draft the user already edited keeps the edit, now dirty against the
 * STORED value (so a later discard goes back to what is stored, not to the
 * initial empty text). `FormDraft` has no "set the baseline only" call, so
 * this goes through its public API: set the stored value, `markApplied` it,
 * then put the edit back. Svelte flushes the DOM once afterwards, so the
 * field never shows the intermediate value. Returns whether the shown text
 * became the stored value.
 */
export function adoptStoredMemo(draft: FormDraft, value: string): boolean {
	const edited = draft.dirty ? memoText(draft.values) : null;
	draft.setValue(MEMO_FIELD, value);
	draft.markApplied(draft.snapshotForApply());
	if (edited === null || edited === value) return true;
	draft.setValue(MEMO_FIELD, edited);
	return false;
}

/**
 * The coordinator with its `settle` calls run ONE AT A TIME (PR #449 review):
 * a close asked while the save button's apply is still waiting for the
 * provider waits for it, then settles what is left (`clean` when the save
 * went through, so it closes without asking). Without this, a second settle
 * could discard - and close - while the first write still lands and stores
 * the discarded text.
 */
export function serializeSettles(
	coordinator: Pick<DraftCoordinator, 'capture' | 'settle'>
): Pick<DraftCoordinator, 'capture' | 'settle'> {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		capture: (keys) => coordinator.capture(keys),
		settle(keys, ask) {
			const run = tail.then(() => coordinator.settle(keys, ask));
			tail = run.catch(() => {});
			return run;
		}
	};
}

/** The command id of the memo save (the pane's button and Ctrl+S share it, plan §3.6). */
export const MEMO_SAVE_COMMAND_ID = 'dashboard.memo.save';

/**
 * May the memo be saved now? The draft has unapplied input and no apply
 * (save button, Ctrl+S, a close's apply) is in flight - the condition the
 * pane's save button had before #435.
 */
export function canSaveMemo(
	memo: Pick<DashboardMemo, 'draft' | 'coordinator' | 'setting'>
): boolean {
	return memo.draft.dirty && !memo.coordinator.settling && !memo.setting.saving;
}

export interface MemoSaveCommandOptions {
	memo: Pick<DashboardMemo, 'draft' | 'coordinator' | 'setting'>;
	/** Resolved label (conventions §13). */
	title: string;
	/** The key (`'Mod+S'`, `#lib/shortcuts.ts`). */
	shortcut: string;
	/** The save itself: {@link DashboardMemo.save} (serialized with closes) and the status line. */
	save: () => void;
}

/**
 * The memo save as ONE command (Issue #435 PR-11, plan §3.6): the pane's save
 * button reads `enabled` / `run` from it, and the page registers it with the
 * app's shortcut dispatcher for Ctrl+S / Cmd+S. So both go through the same
 * `save` - `serializeSettles`, i.e. a close asked meanwhile waits for it.
 *  - `allowInEditable`: the key is pressed in the memo's textarea.
 *  - `preventDefaultWhenDisabled`: on this page Ctrl+S means "save the memo";
 *    with nothing to save (or a save in flight - a second press right after
 *    the first) it does nothing rather than open the browser's "save page".
 *  - `enabled` is checked again by the dispatcher right before `run`.
 */
export function memoSaveCommand(options: MemoSaveCommandOptions): CommandSpec {
	return {
		id: MEMO_SAVE_COMMAND_ID,
		title: options.title,
		shortcut: options.shortcut,
		allowInEditable: true,
		preventDefaultWhenDisabled: true,
		enabled: () => canSaveMemo(options.memo),
		run: options.save
	};
}

/** The memo's text from the draft's values (`''` for anything else). */
export function memoText(values: Readonly<Record<string, unknown>>): string {
	const value = values[MEMO_FIELD];
	return typeof value === 'string' ? value : '';
}

export interface DashboardMemoOptions {
	provider: UiSettingsProvider;
	/** Field label (resolved). */
	label: string;
	/** Router-leave prompt for the coordinator's registry entry (resolved, conventions §13). */
	leaveMessage: () => string;
	messages?: ValidationMessages;
}

export interface DashboardMemo {
	readonly draft: FormDraft;
	readonly coordinator: DraftCoordinator;
	/** {@link serializeSettles} over `coordinator`: give THIS to the dock lifecycle handler. */
	readonly serial: Pick<DraftCoordinator, 'capture' | 'settle'>;
	readonly setting: SavedSetting<string>;
	/** Register the draft's source (page lifetime). Returns the unregister function. */
	register(): () => void;
	/** Read the stored memo into the draft's baseline (an edit made meanwhile is kept). */
	load(): Promise<void>;
	/** The pane's save button: apply without a prompt (serialized with closes). */
	save(): Promise<DraftSettleResult>;
	dispose(): void;
}

export function createDashboardMemo(options: DashboardMemoOptions): DashboardMemo {
	const draft = createFormDraft({
		key: MEMO_PANEL_ID,
		schema: memoSchema(options.label),
		initial: { [MEMO_FIELD]: '' },
		messages: options.messages
	});
	const coordinator = createDraftCoordinator({ message: options.leaveMessage });
	const setting = createSavedSetting<string>({
		provider: options.provider,
		key: MEMO_SETTING_KEY,
		parse: (raw) => raw,
		serialize: (value) => value,
		fallback: () => ''
	});
	// `markApplied` (inside draftSourceFrom) only runs when this resolves true:
	// a failed save keeps the draft dirty.
	const source = draftSourceFrom(draft, (values) => {
		setting.set(memoText(values));
		return setting.save();
	});

	const serial = serializeSettles(coordinator);

	return {
		draft,
		coordinator,
		serial,
		setting,
		register: () => coordinator.register(source),
		async load() {
			const result = await setting.load();
			if (result === 'loaded') adoptStoredMemo(draft, setting.saved ?? '');
		},
		save: () => serial.settle([MEMO_PANEL_ID], () => Promise.resolve('apply')),
		dispose() {
			coordinator.dispose();
			setting.dispose();
		}
	};
}
