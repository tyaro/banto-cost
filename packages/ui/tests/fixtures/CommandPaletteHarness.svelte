<script lang="ts">
	// Test harness: an opener button, the palette (bound `open`), an element
	// outside the palette to receive stray focus, and an optional "layer
	// above" (a dialog after it, z-index `layerZ`) for the Esc-layering test.
	import { CommandPalette, type CommandPaletteItem, type UiMessages } from '../../src/index';

	let {
		items,
		onExecute,
		onClose,
		search,
		recentIds,
		messages,
		focusFallback,
		layerAbove = false,
		layerZ = 5000
	}: {
		items: CommandPaletteItem[];
		onExecute: (item: CommandPaletteItem) => void | Promise<void>;
		onClose?: (reason: string) => void;
		search?: (query: string, items: readonly CommandPaletteItem[]) => CommandPaletteItem[];
		recentIds?: string[];
		messages?: UiMessages;
		focusFallback?: () => HTMLElement | null;
		layerAbove?: boolean;
		layerZ?: number;
	} = $props();

	let open = $state(false);
</script>

<button type="button" data-testid="opener" onclick={() => (open = true)}>Open palette</button>
<button type="button" data-testid="outside">Outside</button>
<span data-testid="state">{open ? 'open' : 'closed'}</span>

<CommandPalette
	bind:open
	{items}
	{onExecute}
	{onClose}
	{search}
	{recentIds}
	{messages}
	{focusFallback}
/>

{#if layerAbove}
	<div role="dialog" aria-label="Above" style="position: fixed; z-index: {layerZ}">
		<button type="button" data-testid="above-button">Above</button>
	</div>
{/if}
