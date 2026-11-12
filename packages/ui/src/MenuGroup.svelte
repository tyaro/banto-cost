<script lang="ts">
	/**
	 * Labeled group of menu items (visual-refresh-design.md §7.1, §7.2):
	 * `role="group"` + `aria-label` for assistive tech, plus a visible
	 * heading (marked `aria-hidden` to avoid double-announcing the label).
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		children: Snippet;
	}

	let { label, children }: Props = $props();
</script>

<div role="group" aria-label={label} class="menu-group">
	<p class="menu-group-label" aria-hidden="true">{label}</p>
	{@render children()}
</div>

<style>
	.menu-group-label {
		margin: var(--banto-space-1) var(--banto-space-2) var(--banto-space-1);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
</style>
