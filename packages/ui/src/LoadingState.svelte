<script lang="ts">
	/**
	 * Page-level loading placeholder (visual-refresh-design.md §6.5): a
	 * skeleton pulse on `--banto-surface-subtle`. The label stays in the
	 * DOM for `aria-live` announcement while the bars themselves are
	 * `aria-hidden` decoration.
	 *
	 * The pulse is stopped outright (not just sped to 0ms) under
	 * `prefers-reduced-motion`, since an infinitely-looping keyframe
	 * animation should be removed, not merely made instantaneous.
	 */
	import { defaultUiMessages } from './messages';

	interface Props {
		label?: string;
		lines?: number;
	}

	let { label, lines = 3 }: Props = $props();
	// Default the a11y label to the package's "loading" message when the caller
	// passes none (i18n layer ①, ADR-0018 §2). Apps that localise pass `label`.
	const resolvedLabel = $derived(label ?? defaultUiMessages.loading());
	const lineIndexes = $derived(Array.from({ length: lines }, (_, index) => index));
</script>

<div class="state" role="status" aria-live="polite">
	<span class="visually-hidden">{resolvedLabel}</span>
	<div class="skeleton-lines" aria-hidden="true">
		{#each lineIndexes as index (index)}
			<div class="skeleton-line" class:short={index === lines - 1}></div>
		{/each}
	</div>
</div>

<style>
	.state {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1.5rem;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.skeleton-lines {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.skeleton-line {
		height: 0.9rem;
		width: 100%;
		border-radius: var(--banto-radius-sm);
		background: var(--banto-surface-subtle);
		/* Ambient loop, deliberately NOT an interaction duration token: the
		   longest one (240ms) reads as flicker on an infinite pulse. The
		   reduced-motion block below removes the loop entirely. */
		animation: banto-skeleton-pulse 1.6s ease-in-out infinite alternate;
	}

	.skeleton-line.short {
		width: 60%;
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton-line {
			animation: none;
			opacity: 0.6;
		}
	}

	@keyframes banto-skeleton-pulse {
		from {
			opacity: 0.6;
		}
		to {
			opacity: 1;
		}
	}
</style>
