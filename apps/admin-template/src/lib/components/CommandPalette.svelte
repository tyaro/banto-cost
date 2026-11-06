<script lang="ts">
	/**
	 * Command palette (spec M16) - the app half. The dialog itself (search
	 * input, grouped list, keyboard, focus trap/restore, window-level Escape,
	 * outside click, look) is `@banto/ui`'s CommandPalette (ADR-0018 §8,
	 * phase 2b). What stays here is what knows about this app: the command
	 * list (`#lib/commands`), admin-core's scored search, the per-user recent
	 * history (#258), failure notifications and the Paraglide text.
	 *
	 * Mounted by (app)/+layout.svelte only while `commandPaletteStore.open`
	 * is true (an `{#if}`), so every open gets a fresh instance - the scope
	 * captured below and the recent-history ordering reset for free. The
	 * Ctrl+K/Cmd+K toggle lives one level up ((app)/+layout.svelte), since it
	 * must also work to CLOSE this palette while its own input has focus.
	 */
	import * as m from '#lib/paraglide/messages.js';
	import { CommandPalette } from '@banto/ui';
	import {
		currentSessionScope,
		isCurrentSessionScope,
		isProviderError,
		notify,
		searchCommands,
		type PaletteCommand
	} from '@banto/admin-core';
	import { buildCommands } from '#lib/commands.js';
	import { loadRecentCommandIds, recordRecentCommand } from '#lib/recentCommands.js';
	import { commandPaletteStore } from '#lib/commandPalette.svelte.js';

	// Built once per mount (navItems is static).
	const commands = buildCommands();

	// The session this palette was opened for. The palette sits OUTSIDE
	// (app)/+layout.svelte's `{#key}` on the session generation, so it is not
	// rebuilt when another tab switches this tab to a different user (#258).
	// Rather than remounting it (which would also drop focus and fight the
	// Ctrl+K toggle, which lives in the layout), it closes itself as soon as
	// the session it was opened for is no longer the live one: what the
	// previous user typed/selected must not be shown to the new user, and a
	// command picked there would run as the new user. Re-opening mounts a
	// fresh instance for the new scope.
	const openedScope = currentSessionScope();
	$effect(() => {
		// `isCurrentSessionScope` reads the controller snapshot, so this
		// re-runs on every generation/owner change.
		if (!isCurrentSessionScope(openedScope)) commandPaletteStore.hide();
	});

	// Derived from the live scope (not read once): the ordering never shows a
	// history that belongs to a previous owner, even for the frame before the
	// effect above has closed the palette.
	const recentIds = $derived(loadRecentCommandIds(currentSessionScope()));

	// admin-core's scored search (prefix > word-start > substring; recent
	// first as the tie-breaker and for the empty query). Recency is an
	// ordering here, not a separate section, so the package's `recentIds`
	// prop is not used.
	function search(query: string, items: readonly PaletteCommand[]): PaletteCommand[] {
		return searchCommands([...items], query, recentIds);
	}

	// The package disables the rows while this runs and closes afterwards
	// (onClose below), so errors are handled here, never rethrown.
	async function execute(command: PaletteCommand): Promise<void> {
		// Captured BEFORE running: a command that ends the session (logout)
		// must not record into the next one (#258).
		const scope = currentSessionScope();
		try {
			await command.run();
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		}
		recordRecentCommand(scope, command.id);
	}
</script>

<CommandPalette
	open
	items={commands}
	{search}
	onExecute={execute}
	onClose={() => commandPaletteStore.hide()}
	messages={{
		commandPaletteLabel: () => m['commandPalette.dialogLabel'](),
		commandPalettePlaceholder: () => m['commandPalette.placeholder'](),
		commandPaletteListLabel: () => m['commandPalette.listLabel'](),
		commandPaletteEmpty: () => m['commandPalette.empty']()
	}}
/>
