<script lang="ts" generics="T extends CommandPaletteItem">
	/**
	 * Command palette (ADR-0018 §8, phase 2b; owner decision 8): display and
	 * interaction only. The app keeps everything that knows about its world -
	 * which commands exist, how to run them, the Ctrl+K wiring, session
	 * scoping (admin-template #258), the recent-items store and failure
	 * notifications - and passes the results in as props / callbacks.
	 *
	 * Standard behaviour (from banto-industrial's banto-hub, #381): focus is
	 * trapped inside while open, Esc is handled at window level (yielding to a
	 * layer above), and on close focus returns to the element that had it when
	 * the palette opened (`layering.ts`, shared with Modal / Drawer). Look follows admin-template
	 * (tokens, @starting-style appearance, `--banto-surface-hover` selected
	 * row).
	 *
	 * Every open mounts a fresh panel (`{#if open}`), so the query, the
	 * selection and the remembered opener reset for free.
	 */
	import type { CommandPaletteCloseReason, CommandPaletteItem } from './commandPalette';
	import type { UiMessages } from './messages';
	import CommandPalettePanel from './CommandPalettePanel.svelte';

	interface Props {
		/** Whether the palette is shown. Bindable; the palette sets it to `false` when it closes itself. */
		open?: boolean;
		/** All commands. Visibility/permission filtering is the app's job (pass only what may be shown). */
		items: readonly T[];
		/** Replaces the built-in search (`defaultCommandPaletteSearch`). Must return the items to show, in display order. */
		search?: (query: string, items: readonly T[]) => readonly T[];
		/** Ids shown first under the "recent" heading when the query is empty (the app owns the store). */
		recentIds?: readonly string[];
		/** Runs the chosen item. The palette disables its rows while a returned promise is pending, then closes. Handle errors inside (a rejection is not caught). */
		onExecute: (item: T) => void | Promise<void>;
		/** Called after the palette closed itself (Esc, outside pointer, or after `onExecute`). */
		onClose?: (reason: CommandPaletteCloseReason) => void;
		/** Where focus goes on close when the opener is gone / inert / hidden. Default: nowhere (focus is left alone). */
		focusFallback?: () => HTMLElement | null | undefined;
		/** Text overrides (layer 1 i18n). Defaults: `defaultUiMessages`. */
		messages?: UiMessages;
	}

	let {
		open = $bindable(false),
		items,
		search,
		recentIds,
		onExecute,
		onClose,
		focusFallback,
		messages
	}: Props = $props();

	function close(reason: CommandPaletteCloseReason): void {
		if (!open) return;
		open = false;
		onClose?.(reason);
	}
</script>

{#if open}
	<CommandPalettePanel
		{items}
		{search}
		{recentIds}
		{onExecute}
		{focusFallback}
		{messages}
		onRequestClose={close}
	/>
{/if}
