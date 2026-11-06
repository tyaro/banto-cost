<script lang="ts">
	/**
	 * Page-level "no data" placeholder (visual-refresh-design.md §6.5).
	 *
	 * Ownership boundary (plan Phase 1): this is for page-level empty states
	 * only. Grid-internal empty states belong to @banto/grid-svelte, which
	 * owns its own markup and references only the shared `--banto-*` tokens.
	 */
	import type { Snippet } from 'svelte';
	import Inbox from './icons/Inbox.svelte';
	import type { UiIconComponent } from './types';

	interface Props {
		icon?: UiIconComponent;
		title: string;
		description?: string;
		action?: Snippet;
	}

	let { icon: Icon = Inbox, title, description, action }: Props = $props();
</script>

<div class="state">
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
		color: var(--banto-text-muted);
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
		font-size: 0.85rem;
		text-wrap: pretty;
	}

	.action {
		margin-top: 0.5rem;
	}
</style>
