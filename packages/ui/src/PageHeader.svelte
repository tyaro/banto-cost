<script lang="ts">
	/**
	 * Page-level heading with an optional description and action slot
	 * (visual-refresh-design.md §6.1). Carries the single view-transition
	 * name used app-wide (§11.1) so the heading cross-fades between pages.
	 *
	 * No app-specific store imports (session/settings/etc.) - kept
	 * portable (lives in @banto/ui, ADR-0018).
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		/** The shell displays the title; retain the document h1 for assistive technology. */
		hideTitle?: boolean;
		description?: string;
		/** Primary action first in DOM order; layout wraps under narrow widths. */
		actions?: Snippet;
	}

	let { title, hideTitle = false, description, actions }: Props = $props();
</script>

{#if hideTitle}
	<h1 class="sr-only">{title}</h1>
{/if}
{#if !hideTitle || description || actions}
	<header class="page-header" class:title-hidden={hideTitle}>
		{#if !hideTitle || description}
			<div>
				{#if !hideTitle}
					<h1>{title}</h1>
				{/if}
				{#if description}
					<p>{description}</p>
				{/if}
			</div>
		{/if}
		{#if actions}
			<div class="actions">
				{@render actions()}
			</div>
		{/if}
	</header>
{/if}

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	.page-header {
		view-transition-name: page-header;
		/* The transition name creates a stacking context. Keep action popovers
		   above sticky grid cells, while leaving the shell header above them. */
		position: relative;
		z-index: calc(var(--banto-z-header) - 1);
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem 1rem;
	}

	h1 {
		margin: 0;
		font-size: 1.15rem;
		line-height: 1.5;
		font-weight: 600;
		font-feature-settings: 'palt';
		text-wrap: balance;
	}

	p {
		margin: 0.25rem 0 0;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
		text-wrap: pretty;
	}

	.title-hidden p {
		margin: 0;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
</style>
