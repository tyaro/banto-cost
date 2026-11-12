<script lang="ts">
	/**
	 * Page-level error placeholder (visual-refresh-design.md §6.5). Shares
	 * the EmptyState/LoadingState DOM shape (icon, heading, caption,
	 * optional action) so the three read as one family across pages.
	 *
	 * Ownership boundary (plan Phase 1): page-level only - grid cell errors
	 * stay owned by @banto/grid-svelte.
	 */
	import type { Snippet } from 'svelte';
	import OctagonAlert from './icons/OctagonAlert.svelte';
	import type { UiIconComponent } from './types';

	interface Props {
		icon?: UiIconComponent;
		title: string;
		description?: string;
		action?: Snippet;
	}

	let { icon: Icon = OctagonAlert, title, description, action }: Props = $props();
</script>

<div class="state" role="alert">
	<Icon size={32} aria-hidden="true" />
	<h2>{title}</h2>
	{#if description}
		<p>{description}</p>
	{/if}
	{#if action}
		<div class="action">
			{@render action()}
		</div>
	{/if}
</div>

<style>
	.state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--banto-space-2);
		padding: var(--banto-space-8) var(--banto-space-6);
		text-align: center;
		color: var(--banto-danger);
	}

	h2 {
		margin: 0;
		color: var(--banto-text);
		font-size: var(--banto-font-size-base);
		font-weight: 600;
	}

	p {
		margin: 0;
		max-width: 32rem;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
		text-wrap: pretty;
	}

	.action {
		margin-top: var(--banto-space-2);
	}
</style>
