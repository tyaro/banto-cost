<script lang="ts" generics="TData = unknown">
	/**
	 * A tree-select input: a trigger showing the current selection, opening a
	 * {@link BantoTree} in a native `popover="auto"` dropdown (top-layer render
	 * + built-in outside-click light-dismiss + Escape — no manual listeners).
	 *
	 * `single` mode picks one node (closes on pick); `multiple` mode uses
	 * tri-state checkboxes and stays open. Emits the raw value via `onChange`
	 * so an app can `bind:value` it stand-alone OR wire it to a
	 * `@banto/forms` `FormStore` manually (`store.setValue` / `store.touch`) —
	 * this control deliberately does NOT import `@banto/forms` (cross-package
	 * imports are banned; the app composes the two).
	 */
	import BantoTree from './BantoTree.svelte';
	import { findNode } from './core/tree';
	import type { NodeId, TreeNode } from './core/types';
	import { defaultTreeMessages, type TreeMessages } from './messages';

	interface TreeSelectMessages extends TreeMessages {
		/** Placeholder shown when nothing is selected. */
		placeholder?: () => string;
		/** Trigger label in multiple mode (n = count). */
		selectedCount?: (n: number) => string;
	}

	interface Props {
		nodes: TreeNode<TData>[];
		/** Selected id in single mode (`bind:value`). */
		value?: NodeId | null;
		/** Selected ids in multiple mode (`bind:values`). */
		values?: NodeId[];
		/** Multi-select with checkboxes (default `false`). */
		multiple?: boolean;
		/** Disable the control. */
		disabled?: boolean;
		/** Initially expanded node ids. */
		expanded?: NodeId[];
		/** id for a `<label for>` association. */
		id?: string;
		/** Fetch a lazy branch's children on first expand. */
		loadChildren?: (node: TreeNode<TData>) => Promise<TreeNode<TData>[]>;
		messages?: TreeSelectMessages;
		/** Selection changed: `NodeId | null` (single) or `NodeId[]` (multiple). */
		onChange?: (value: NodeId | null | NodeId[]) => void;
		/** Blur / dismiss (for form `touch`). */
		onBlur?: () => void;
	}

	let {
		nodes,
		value = $bindable(null),
		values = $bindable([]),
		multiple = false,
		disabled = false,
		expanded,
		id,
		loadChildren,
		messages,
		onChange,
		onBlur
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	const t = {
		...defaultTreeMessages,
		placeholder: () => '選択してください',
		selectedCount: (n: number) => `${n} 件選択`,
		...messages
	};

	let triggerEl = $state<HTMLButtonElement | null>(null);
	let popoverEl = $state<HTMLDivElement | null>(null);
	let open = $state(false);
	let pos = $state<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

	const triggerLabel = $derived.by(() => {
		if (multiple) {
			return values.length === 0 ? t.placeholder() : t.selectedCount(values.length);
		}
		if (value === null || value === undefined) return t.placeholder();
		return findNode(nodes, value)?.label ?? t.placeholder();
	});
	const hasValue = $derived(multiple ? values.length > 0 : value !== null && value !== undefined);

	function computePosition(): void {
		if (!triggerEl || !popoverEl) return;
		const r = triggerEl.getBoundingClientRect();
		const menuH = popoverEl.getBoundingClientRect().height;
		const below = window.innerHeight - r.bottom;
		const top =
			menuH > 0 && below < menuH && r.top > below ? Math.max(4, r.top - menuH - 4) : r.bottom + 4;
		pos = { top, left: r.left, width: r.width };
	}

	function toggleOpen(): void {
		if (disabled) return;
		if (open) popoverEl?.hidePopover();
		else popoverEl?.showPopover();
	}

	function onToggle(event: ToggleEvent): void {
		open = event.newState === 'open';
		if (open) {
			computePosition();
		} else {
			onBlur?.();
		}
	}

	function onSelectionChange(ids: NodeId[]): void {
		if (multiple) return;
		const next = ids[0] ?? null;
		value = next;
		onChange?.(next);
		popoverEl?.hidePopover();
	}

	function onCheckChange(ids: NodeId[]): void {
		if (!multiple) return;
		values = ids;
		onChange?.(ids);
	}
</script>

<svelte:window onresize={() => open && computePosition()} />

<button
	type="button"
	class="trigger banto-input"
	class:placeholder={!hasValue}
	{id}
	{disabled}
	bind:this={triggerEl}
	aria-haspopup="tree"
	aria-expanded={open}
	onclick={toggleOpen}
>
	<span class="trigger-label">{triggerLabel}</span>
	<span class="trigger-caret" aria-hidden="true">▾</span>
</button>

<div
	class="popover"
	popover="auto"
	role="dialog"
	bind:this={popoverEl}
	style:top={`${pos.top}px`}
	style:left={`${pos.left}px`}
	style:min-width={`${pos.width}px`}
	ontoggle={onToggle}
>
	<BantoTree
		{nodes}
		{expanded}
		{loadChildren}
		selectionMode={multiple ? 'none' : 'single'}
		checkboxes={multiple}
		selected={multiple ? [] : value !== null && value !== undefined ? [value] : []}
		checked={multiple ? values : []}
		{onSelectionChange}
		{onCheckChange}
	/>
</div>

<style>
	.trigger {
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		text-align: start;
		cursor: pointer;
	}
	.trigger:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
	.trigger.placeholder .trigger-label {
		color: var(--banto-text-muted);
	}
	.trigger-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.trigger-caret {
		flex: 0 0 auto;
		color: var(--banto-text-muted);
		font-size: 0.75rem;
	}

	.popover {
		position: fixed;
		inset: auto;
		margin: 0;
		max-height: min(60vh, 360px);
		overflow: auto;
		padding: 0.25rem;
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-lg);
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}
	.popover:not(:popover-open) {
		display: none;
	}
</style>
