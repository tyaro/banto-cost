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
		gap: 0.5rem;
		padding: 3rem 1.5rem;
		text-align: center;
		color: var(--banto-danger);
	}

	h2 {
		margin: 0;
		color: var(--banto-text);
		font-size: 1rem;
		font-weight: 600;
	}

	p {
		margin: 0;
		max-width: 32rem;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
		text-wrap: pretty;
	}

	.action {
		margin-top: 0.5rem;
	}
</style>
