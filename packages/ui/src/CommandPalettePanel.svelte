<script lang="ts" generics="T extends CommandPaletteItem">
	/**
	 * The open state of CommandPalette.svelte (package-internal, not exported).
	 * Mounted only while open, so onMount / its cleanup are "opened" /
	 * "closed" - the opener is captured on mount and focus is restored in the
	 * cleanup. See CommandPalette.svelte for the contract.
	 */
	import { onMount, tick } from 'svelte';
	import {
		defaultCommandPaletteSearch,
		groupCommandPaletteItems,
		type CommandPaletteCloseReason,
		type CommandPaletteItem
	} from './commandPalette';
	import { defaultUiMessages, type UiMessages } from './messages';
	import { attachFocusTrap, hasVisibleLayerAbove, restoreFocus } from './layering';

	interface Props {
		items: readonly T[];
		search?: (query: string, items: readonly T[]) => readonly T[];
		recentIds?: readonly string[];
		onExecute: (item: T) => void | Promise<void>;
		focusFallback?: () => HTMLElement | null | undefined;
		messages?: UiMessages;
		onRequestClose: (reason: CommandPaletteCloseReason) => void;
	}

	let {
		items,
		search = defaultCommandPaletteSearch,
		recentIds = [],
		onExecute,
		focusFallback,
		messages,
		onRequestClose
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });
	const uid = $props.id();
	const listId = `${uid}-list`;
	const optionId = (index: number) => `${uid}-option-${index}`;

	let query = $state('');
	let selectedIndex = $state(0);
	let executing = $state(false);
	let inputEl: HTMLInputElement | undefined = $state();
	let paletteEl: HTMLDivElement | undefined = $state();

	const results = $derived(search(query, items));

	// Recent items only for an empty query, resolved from the results so a
	// stale id (command no longer offered) simply drops out.
	const recentItems = $derived.by((): T[] => {
		if (query.trim() !== '' || recentIds.length === 0) return [];
		const byId = new Map(results.map((item) => [item.id, item]));
		const seen = new Set<string>();
		const list: T[] = [];
		for (const id of recentIds) {
			const item = byId.get(id);
			if (item && !seen.has(id)) {
				seen.add(id);
				list.push(item);
			}
		}
		return list;
	});

	const groups = $derived(groupCommandPaletteItems(results, recentItems, t.commandPaletteRecent()));
	const ordered = $derived(groups.flatMap((group) => group.rows.map((row) => row.item)));
	const selectedItem = $derived(selectedIndex >= 0 ? ordered[selectedIndex] : undefined);

	function isSelectable(item: T | undefined): boolean {
		return item !== undefined && !item.disabled;
	}

	/** Next selectable index from `from` stepping by `step` (wrapping); `from` itself if none. */
	function step(origin: number, by: 1 | -1): number {
		let from = origin;
		const count = ordered.length;
		if (count === 0) return -1;
		// -1 = nothing selected: ArrowDown starts at the first row, ArrowUp at the last.
		if (from < 0) from = by === 1 ? -1 : 0;
		for (let i = 1; i <= count; i++) {
			const next = (((from + by * i) % count) + count) % count;
			if (isSelectable(ordered[next])) return next;
		}
		return origin;
	}

	// A fresh query means a fresh result set - pin the selection to the first
	// selectable row rather than whatever now occupies the old index.
	$effect(() => {
		const list = ordered;
		const first = list.findIndex((item) => !item.disabled);
		// -1 (no selectable row) means nothing is selected - never a disabled row.
		selectedIndex = first;
	});

	// The element focused when the palette opened (promise 5, layering.ts).
	// Not $state - never rendered.
	let opener: HTMLElement | null = null;
	// Set when this panel is torn down (Esc / outside / parent set open=false).
	// A pending onExecute that settles afterwards must not close, refocus or
	// otherwise touch whatever palette is open by then. Not $state.
	let destroyed = false;

	onMount(() => {
		const active = document.activeElement;
		opener = active instanceof HTMLElement ? active : null;
		inputEl?.focus();
		return () => {
			destroyed = true;
			const previous = opener;
			opener = null;
			// Decide after tick(): a command that navigates can make the opener
			// disappear / go inert in the same flow, and restoring first would
			// drop focus onto <body> right after.
			void tick().then(() => restoreFocus(previous, focusFallback));
		};
	});

	$effect(() => {
		const node = paletteEl;
		if (!node) return;
		return attachFocusTrap(node);
	});

	async function execute(item: T): Promise<void> {
		if (executing || item.disabled) return;
		executing = true;
		try {
			await onExecute(item);
		} finally {
			if (!destroyed) {
				executing = false;
				onRequestClose('execute');
			}
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				selectedIndex = step(selectedIndex, 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				selectedIndex = step(selectedIndex, -1);
				break;
			case 'Enter':
				event.preventDefault();
				if (selectedItem && isSelectable(selectedItem)) void execute(selectedItem);
				break;
			// Escape is handled at window level (handleWindowKeydown), so it
			// works wherever focus is.
		}
	}

	// Promises 1-3 (layering.ts): consume the Esc that closes us, yield
	// to an Esc already consumed or to a layer above.
	function handleWindowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		if (paletteEl && hasVisibleLayerAbove({ except: paletteEl })) return;
		event.preventDefault();
		onRequestClose('escape');
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (paletteEl && event.target instanceof Node && !paletteEl.contains(event.target)) {
			onRequestClose('outside');
		}
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div class="overlay">
	<div
		class="palette"
		role="dialog"
		aria-modal="true"
		aria-label={t.commandPaletteLabel()}
		bind:this={paletteEl}
	>
		<input
			type="text"
			class="search"
			placeholder={t.commandPalettePlaceholder()}
			autocomplete="off"
			spellcheck="false"
			role="combobox"
			aria-expanded="true"
			aria-controls={listId}
			aria-activedescendant={isSelectable(selectedItem) ? optionId(selectedIndex) : undefined}
			bind:value={query}
			bind:this={inputEl}
			onkeydown={handleKeydown}
		/>

		<div class="results" id={listId} role="listbox" aria-label={t.commandPaletteListLabel()}>
			{#if ordered.length === 0}
				<p class="empty">{t.commandPaletteEmpty()}</p>
			{/if}
			{#each groups as group (group.key)}
				{#if group.heading !== undefined}
					<div class="group-heading">{group.heading}</div>
				{/if}
				{#each group.rows as row (row.item.id)}
					{@const Icon = row.item.icon}
					<button
						id={optionId(row.index)}
						type="button"
						class="result"
						class:rich={Icon !== undefined || row.item.shortcut !== undefined}
						class:selected={selectedIndex >= 0 && row.index === selectedIndex}
						role="option"
						aria-selected={selectedIndex >= 0 && row.index === selectedIndex}
						aria-disabled={row.item.disabled ? 'true' : undefined}
						disabled={executing || row.item.disabled}
						onmouseenter={() => {
							if (!row.item.disabled) selectedIndex = row.index;
						}}
						onclick={() => execute(row.item)}
					>
						{#if Icon}
							<span class="icon"><Icon size={16} aria-hidden="true" /></span>
						{/if}
						{#if Icon || row.item.shortcut}
							<span class="title">{row.item.title}</span>
						{:else}
							{row.item.title}
						{/if}
						{#if row.item.shortcut}
							<kbd class="shortcut">{row.item.shortcut}</kbd>
						{/if}
					</button>
				{/each}
			{/each}
		</div>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: var(--banto-z-overlay);
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 12vh;
		background: var(--banto-scrim);
	}

	.palette {
		display: flex;
		flex-direction: column;
		width: min(560px, calc(100vw - 2rem));
		max-height: min(60vh, 480px);
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-lg);
		overflow: hidden;
		/* Glass preset: no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		/* Appearance motion: fade + scale(0.98 -> 1). @starting-style also
		   fires on the first paint of a freshly inserted element (this panel
		   is mounted per open); browsers without it just skip the motion. */
		opacity: 1;
		transform: scale(1);
		transition:
			opacity var(--banto-duration-slow) var(--banto-ease-spring),
			transform var(--banto-duration-slow) var(--banto-ease-spring);
	}

	@starting-style {
		.palette {
			opacity: 0;
			transform: scale(0.98);
		}
	}

	.search {
		flex: 0 0 auto;
		width: 100%;
		box-sizing: border-box;
		padding: 0.9rem 1rem;
		border: none;
		border-bottom: 1px solid var(--banto-border);
		background: transparent;
		color: var(--banto-text);
		font-size: 1rem;
	}

	.search:focus {
		outline: none;
	}

	.results {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.4rem;
	}

	.empty {
		margin: 0;
		padding: 1rem;
		text-align: center;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
	}

	.group-heading {
		padding: 0.5rem 0.6rem 0.25rem;
		color: var(--banto-text-muted);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.result {
		display: block;
		width: 100%;
		box-sizing: border-box;
		padding: 0.55rem 0.7rem;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font-size: 0.875rem;
		text-align: left;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Only rows with an icon or a shortcut switch to flex, so plain rows keep
	   exactly the block layout (and pixels) they had before. */
	.result.rich {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}

	.icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--banto-text-muted);
	}

	.title {
		flex: 1;
		min-width: 0;
	}

	.shortcut {
		flex: 0 0 auto;
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-sm);
		color: var(--banto-text-muted);
		font-family: inherit;
		font-size: 0.75rem;
	}

	.result:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* Selection tracks the mouse-hovered / keyboard-active row as one state
	   (onmouseenter sets selectedIndex): the neutral --banto-surface-hover
	   used for transient hover/focus elsewhere (MenuItem), distinct from a
	   persistent "current page" indicator. */
	.result.selected {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}
</style>
