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
		gap: var(--banto-space-2);
		padding: var(--banto-space-8) var(--banto-space-6);
		text-align: center;
		color: var(--banto-text-muted);
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
		font-size: var(--banto-font-size-md);
		text-wrap: pretty;
	}

	.action {
		margin-top: var(--banto-space-2);
	}
</style>
