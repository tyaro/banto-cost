<script lang="ts">
	/**
	 * Menu item (visual-refresh-design.md §7.2, §7.5). `role="menuitem"` +
	 * `tabindex="-1"` roving focus - Menu.svelte moves focus imperatively
	 * via `.focus()`, so items never need to enter native Tab order.
	 * Enter/Space selection comes for free from being a real `<button>`.
	 *
	 * `disabled` uses `aria-disabled` rather than the native `disabled`
	 * attribute (§7.5) so the item stays reachable for `aria-disabled`
	 * inspection during traversal while visually/interactively inert.
	 */
	import { getMenuContext } from './menuContext';
	import type { UiIconComponent } from './types';

	interface Props {
		label: string;
		icon?: UiIconComponent;
		danger?: boolean;
		disabled?: boolean;
		onSelect: () => void;
	}

	let { label, icon: Icon, danger = false, disabled = false, onSelect }: Props = $props();

	const menu = getMenuContext();

	let itemEl: HTMLButtonElement | undefined = $state();

	$effect(() => {
		if (!itemEl) return;
		return menu.registerItem(itemEl);
	});

	function handleClick(): void {
		if (disabled) return;
		onSelect();
		menu.close();
	}
</script>

<button
	bind:this={itemEl}
	type="button"
	role="menuitem"
	tabindex="-1"
	class="menu-item"
	class:danger
	class:disabled
	aria-disabled={disabled ? 'true' : undefined}
	onclick={handleClick}
>
	{#if Icon}
		<Icon size={16} aria-hidden="true" />
	{/if}
	<span>{label}</span>
</button>

<style>
	.menu-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		box-sizing: border-box;
		padding: 0.45rem 0.6rem;
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text);
		font-size: 0.85rem;
		text-align: left;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.menu-item:hover,
	.menu-item:focus-visible {
		background: var(--banto-surface-hover);
		outline: none;
	}

	.menu-item.danger {
		color: var(--banto-danger);
	}

	.menu-item.danger:hover,
	.menu-item.danger:focus-visible {
		background: var(--banto-danger-tint);
	}

	.menu-item.disabled {
		color: var(--banto-text-muted);
		cursor: not-allowed;
		pointer-events: none;
		opacity: 0.6;
	}
</style>
