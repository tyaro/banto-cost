<script lang="ts">
	/**
	 * Icon-only button (visual-refresh-design.md §6.3). `label` is required
	 * so an accessible name can never be forgotten - it feeds both
	 * `aria-label` and a `title` tooltip.
	 */
	import type { UiIconComponent } from './types';

	interface Props {
		label: string;
		icon: UiIconComponent;
		size?: 'sm' | 'md';
		/** Disclosure state of what the button controls (aria-expanded); omitted = not a disclosure. */
		expanded?: boolean;
		/** id of the controlled element (aria-controls). */
		controls?: string;
		onclick: (event: MouseEvent) => void;
	}

	let { label, icon: Icon, size = 'md', expanded, controls, onclick }: Props = $props();
</script>

<button
	type="button"
	class="icon-button"
	class:icon-button--sm={size === 'sm'}
	aria-label={label}
	title={label}
	aria-expanded={expanded}
	aria-controls={controls}
	{onclick}
>
	<Icon size={size === 'sm' ? 16 : 20} aria-hidden="true" />
</button>

<style>
	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--banto-control-height);
		height: var(--banto-control-height);
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.icon-button--sm {
		width: var(--banto-control-height-sm);
		height: var(--banto-control-height-sm);
	}

	.icon-button:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.icon-button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}
</style>
