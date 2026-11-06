<script lang="ts">
	/**
	 * Toast stack (ADR-0018 §8, phase 2c): displays a `createToastStore()`
	 * store, mounted once in the app's root layout. Fixed bottom-right by
	 * default; move it with the CSS custom properties `--banto-toast-right` /
	 * `--banto-toast-bottom` (default `1rem`) set on an ancestor.
	 *
	 * Announcements: two persistent live regions, so assistive tech sees the
	 * regions exist before a toast lands in them - `error` / `warning` go to
	 * a `role="alert"` (assertive) region, `success` / `info` to a
	 * `role="status"` (polite) one. Each toast may carry an action button
	 * (banto-hub's undo, standard here) and always a close button; both are
	 * plain focusable buttons. The look follows admin-template (tint per
	 * kind, slide-in from the right, glass opt-in via `--banto-backdrop`).
	 */
	import { defaultUiMessages, type UiMessages } from './messages';
	import type { Toast, ToastStore } from './toast.svelte';

	interface Props {
		/** The store to display (from `createToastStore()`). */
		store: ToastStore;
		/** Text overrides (layer 1 i18n): `toastClose`. Defaults: `defaultUiMessages`. */
		messages?: UiMessages;
	}

	let { store, messages }: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });

	const urgent = (toast: Toast) => toast.kind === 'error' || toast.kind === 'warning';
	const polite = $derived(store.toasts.filter((toast) => !urgent(toast)));
	const assertive = $derived(store.toasts.filter(urgent));
</script>

{#snippet toastItem(toast: Toast)}
	<div class="toast {toast.kind}" data-kind={toast.kind}>
		<span class="message">{toast.message}</span>
		{#if toast.action}
			<button
				type="button"
				class="action"
				data-testid={`toast-action-${toast.id}`}
				onclick={toast.action.onAction}
			>
				{toast.action.label}
			</button>
		{/if}
		<button
			type="button"
			class="close"
			onclick={() => store.dismiss(toast.id)}
			aria-label={t.toastClose()}
		>
			×
		</button>
	</div>
{/snippet}

<div class="toast-host">
	<div class="toast-group" class:empty={polite.length === 0} role="status" aria-live="polite">
		{#each polite as toast (toast.id)}
			{@render toastItem(toast)}
		{/each}
	</div>
	<div class="toast-group" class:empty={assertive.length === 0} role="alert" aria-live="assertive">
		{#each assertive as toast (toast.id)}
			{@render toastItem(toast)}
		{/each}
	</div>
</div>

<style>
	.toast-host {
		position: fixed;
		right: var(--banto-toast-right, 1rem);
		bottom: var(--banto-toast-bottom, 1rem);
		display: flex;
		flex-direction: column;
		z-index: var(--banto-z-toast);
		max-width: 320px;
	}

	.toast-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	/* The gap between the two live regions only exists while both show toasts. */
	.toast-group:not(.empty) ~ .toast-group:not(.empty) {
		margin-top: 0.5rem;
	}

	.toast {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.8rem;
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-left-width: 4px;
		border-left-color: var(--banto-border-strong);
		box-shadow: var(--banto-shadow-lg);
		font-size: 0.85rem;
		color: var(--banto-text);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop:
		   none), same opt-in as CommandPalette's overlay. */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		/* Slide-in from the right (design.md §11.2). Finite animation driven
		   entirely by the duration token, so prefers-reduced-motion (which
		   zeroes --banto-duration-base in banto.css) collapses it to an
		   instant appearance with no extra media query needed here. */
		animation: banto-toast-in var(--banto-duration-base) var(--banto-ease-spring);
	}

	.toast.success {
		background: var(--banto-success-tint);
		border-left-color: var(--banto-success-solid);
		color: var(--banto-success-tint-text);
	}

	.toast.error {
		background: var(--banto-danger-tint);
		border-left-color: var(--banto-danger-solid);
		color: var(--banto-danger-tint-text);
	}

	.toast.warning {
		/* No --banto-warning-solid token (only danger/success have a -solid
		   variant); the base --banto-warning accent plays that role, paired
		   with the warning tint/tint-text (theme Appendix A.3). */
		background: var(--banto-warning-tint);
		border-left-color: var(--banto-warning);
		color: var(--banto-warning-tint-text);
	}

	.toast.info {
		/* No --banto-primary-tint token exists (plan Appendix A.3 only defines
		   tint pairs for danger/success/warning) - same color-mix fallback
		   StatusBadge's `info` variant already uses. */
		background: color-mix(in srgb, var(--banto-primary) 16%, var(--banto-surface-overlay));
		border-left-color: var(--banto-primary);
		color: var(--banto-primary);
	}

	.message {
		flex: 1;
	}

	/* Action button (banto-hub's undo): outlined in the toast's own text
	   colour so it reads on every tint, same hover / focus language as the
	   close button. */
	.action {
		flex: none;
		border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
		border-radius: var(--banto-radius-sm);
		background: none;
		color: inherit;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		padding: 0.2rem 0.5rem;
		white-space: nowrap;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.action:hover {
		background: color-mix(in srgb, currentColor 14%, transparent);
	}

	.action:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: none;
		color: inherit;
		opacity: 0.65;
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 0.3rem;
		border-radius: var(--banto-radius-sm);
		transition:
			opacity var(--banto-duration-fast) var(--banto-ease-out),
			background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.close:hover {
		opacity: 1;
		background: color-mix(in srgb, currentColor 14%, transparent);
	}

	.close:focus-visible {
		outline: none;
		opacity: 1;
		box-shadow: var(--banto-focus-ring);
	}

	@keyframes banto-toast-in {
		from {
			opacity: 0;
			transform: translateX(24px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
