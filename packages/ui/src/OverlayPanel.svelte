<script lang="ts">
	/**
	 * The shared body of Modal.svelte and Drawer.svelte (package-internal, not
	 * exported; docs/adr/0018-shared-ui-package.md §10, phase 4). The two
	 * differ only in placement and motion (`variant`), so the logic lives
	 * once here - banto-hub kept two copies that had to be edited in lockstep.
	 *
	 * Contract (banto-hub T13-1 / T19 S1-b / TAG-UX-C / #381, unchanged):
	 *
	 * - Esc, the scrim click and × all go through one `requestClose()`:
	 *   `onRequestClose()` may veto, then `onclose()`. It is idempotent - an
	 *   outro keeps the panel clickable for a moment, and a second × must not ask
	 *   the unsaved-changes question twice. "Closed" means the parent set `open`
	 *   to false: a parent that keeps it open (no `onclose`, or a later decision)
	 *   leaves a fully working, still detectable layer.
	 * - `dirty` blocks only the accidental routes (Esc, scrim) and reports
	 *   `onBlockedClose()`; × is deliberate and always reaches `onRequestClose`
	 *   (`isCloseAllowed`).
	 * - The layer promises of `layering.ts`: Esc at window level, consumed when
	 *   it closes us, yielded to an already-consumed Esc or a layer above;
	 *   `data-layer-inactive` from the moment `open` is false (promise 6, set
	 *   synchronously when the parent closed inside `onclose` - the re-render is
	 *   too late for the next Esc); focus trap while open; focus back to the
	 *   opener on close.
	 * - Motion is CSS, driven by the theme's motion tokens like Menu / ToastHost /
	 *   CommandPalette (`--banto-duration-*`, `--banto-ease-out`; reduced motion
	 *   turns the tokens to 0ms): the entry uses `@starting-style`, the exit keeps
	 *   the layer mounted (`leaving`) for `--banto-duration-base`, `inert` so
	 *   neither Tab nor clicks can reach the fading layer (`data-layer-inactive`
	 *   alone only hides it from the layer checks).
	 * - On open, focus goes to the first focusable (the × in the header comes
	 *   first in DOM order).
	 *
	 * The opener is captured in `$effect.pre` (before `focusFirst` moves focus)
	 * and restored after `tick()`: the same update that closes the layer can
	 * remove the opener (deleting the row being edited), and restoring before the
	 * DOM update would focus a node that disappears right after.
	 */
	import { onDestroy, tick, untrack } from 'svelte';
	import IconButton from './IconButton.svelte';
	import X from './icons/X.svelte';
	import {
		attachFocusTrap,
		focusablesIn,
		hasVisibleLayerAbove,
		isCloseAllowed,
		LAYER_INACTIVE_ATTR,
		restoreFocus
	} from './layering';
	import { defaultUiMessages } from './messages';
	import type { OverlayProps } from './overlay';

	interface Props extends OverlayProps {
		variant: 'modal' | 'drawer';
	}

	let {
		variant,
		open,
		title,
		width,
		closeOnOverlayClick = true,
		onclose,
		onRequestClose,
		dirty = false,
		onBlockedClose,
		focusFallback,
		messages,
		children
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });

	/** The `role="dialog"` panel - the `except` of the layer checks. */
	let panelEl: HTMLDivElement | undefined = $state();

	let overlayEl: HTMLDivElement | undefined = $state();

	/**
	 * A close request is in flight (between `onRequestClose` and the parent's
	 * answer). Blocks re-entry only within the same tick: if the parent keeps
	 * `open` true, it is cleared again so the controls keep working.
	 */
	let requesting = false;

	function requestClose(): void {
		if (!open || requesting) return;
		if (onRequestClose && !onRequestClose()) return;
		requesting = true;
		onclose?.();
		// Props are live: a parent that closed inside `onclose` is visible now.
		if (!open) panelEl?.setAttribute(LAYER_INACTIVE_ATTR, 'true');
		void tick().then(() => {
			requesting = false;
		});
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!open || requesting || event.key !== 'Escape') return;
		// Promises 1-2: the listener of a layer opened earlier runs first, so
		// `defaultPrevented` alone is not enough - also yield to a layer above.
		if (event.defaultPrevented || hasVisibleLayerAbove({ except: panelEl })) return;
		event.preventDefault();
		if (!isCloseAllowed('escape', dirty)) {
			onBlockedClose?.();
			return;
		}
		requestClose();
	}

	// Only a click on the scrim itself (not one bubbling from the panel), so
	// the panel needs no stopPropagation click handler. It also yields to a
	// layer above (promise 2), like Esc: a fixed overlay nested in the panel is
	// confined to it when the panel is a containing block (an app's transform /
	// filter on it, or an engine treating backdrop-filter that way), so a click
	// beside it lands on OUR scrim - closing here
	// would take the child down too, past its own `dirty` / `onRequestClose`.
	function handleOverlayClick(event: MouseEvent): void {
		if (!closeOnOverlayClick || event.target !== event.currentTarget) return;
		if (hasVisibleLayerAbove({ except: panelEl })) return;
		if (!isCloseAllowed('overlay', dirty)) {
			onBlockedClose?.();
			return;
		}
		requestClose();
	}

	// Promise 5: remember the opener on the open transition, give focus back
	// on the close transition (only on transitions, not on every run).
	let opener: HTMLElement | null = null;
	let openHandled = false;

	/** Still mounted for the exit motion after `open` turned false (inactive, promise 6). */
	let leaving = $state(false);
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;

	/** The exit motion's length, read from the theme token (0 when unset or reduced motion). */
	function exitMs(): number {
		const node = overlayEl;
		if (!node) return 0;
		const raw = getComputedStyle(node).getPropertyValue('--banto-duration-base').trim();
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value) || value <= 0) return 0;
		if (raw.endsWith('ms')) return value;
		return raw.endsWith('s') ? value * 1000 : 0;
	}

	$effect.pre(() => {
		const isOpen = open;
		untrack(() => {
			if (isOpen === openHandled) return;
			openHandled = isOpen;
			clearTimeout(leaveTimer);
			if (isOpen) {
				// Reopened during the exit motion: the same DOM stays, so the
				// mount-time `focusFirst` does not run again - do it here.
				if (leaving) void tick().then(() => panelEl && focusFirst(panelEl));
				leaving = false;
				const active = document.activeElement;
				opener = active instanceof HTMLElement ? active : null;
			} else {
				const previous = opener;
				opener = null;
				const ms = exitMs();
				if (ms > 0) {
					leaving = true;
					leaveTimer = setTimeout(() => (leaving = false), ms);
				}
				void tick().then(() => restoreFocus(previous, () => focusFallback?.()));
			}
		});
	});

	onDestroy(() => clearTimeout(leaveTimer));

	// Promise 4 while open (`panelEl` is bound inside `{#if open}`).
	$effect(() => {
		if (!open) return;
		const node = panelEl;
		if (!node) return;
		return attachFocusTrap(node);
	});

	function focusFirst(node: HTMLElement): void {
		(focusablesIn(node)[0] ?? node).focus();
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open || leaving}
	<div
		class="overlay"
		class:overlay--drawer={variant === 'drawer'}
		class:overlay--modal={variant === 'modal'}
		class:leaving={!open}
		inert={!open}
		role="presentation"
		onclick={handleOverlayClick}
		bind:this={overlayEl}
	>
		<div
			class="panel"
			class:panel--drawer={variant === 'drawer'}
			class:panel--modal={variant === 'modal'}
			bind:this={panelEl}
			role="dialog"
			data-layer-inactive={open ? undefined : 'true'}
			aria-modal="true"
			aria-label={title}
			style:width
			use:focusFirst
		>
			<div class="header">
				{#if title}<h3>{title}</h3>{/if}
				<span class="close">
					<IconButton label={t.overlayClose()} icon={X} size="sm" onclick={() => requestClose()} />
				</span>
			</div>
			<div class="body">
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: var(--banto-z-modal);
		display: flex;
		background: var(--banto-scrim);
		opacity: 1;
		transition: opacity var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Exit: fade the scrim and move the panel back out while still mounted. */
	.overlay.leaving {
		opacity: 0;
		pointer-events: none;
	}

	@starting-style {
		.overlay {
			opacity: 0;
		}
	}

	.overlay--drawer {
		justify-content: flex-end;
	}

	.overlay--modal {
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.panel {
		display: flex;
		flex-direction: column;
		max-width: calc(100vw - 2rem);
		background: var(--banto-surface-overlay);
		color: var(--banto-text);
		box-shadow: var(--banto-shadow-lg);
		/* Glass preset: no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		transition: transform var(--banto-duration-base) var(--banto-ease-out);
	}

	/* Motion distances are local, like Menu (-4px) / ToastHost (24px) /
	   CommandPalette (0.98); durations and easing come from the theme. The
	   resting state is `transform: none` on purpose: any other transform makes
	   the panel the containing block of fixed descendants, so a Modal placed in
	   the body would be confined to the panel in every theme. Only the entry
	   (@starting-style) and the exit (.leaving) move the panel. */
	.panel--drawer {
		height: 100%;
		border-left: 1px solid var(--banto-border);
		transform: none;
	}

	.leaving .panel--drawer {
		transform: translateX(48px);
	}

	.panel--modal {
		max-height: calc(100vh - 3rem);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		transform: none;
	}

	.leaving .panel--modal {
		transform: scale(0.96);
	}

	@starting-style {
		.panel--drawer {
			transform: translateX(48px);
		}

		.panel--modal {
			transform: scale(0.96);
		}
	}

	.header {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--banto-border);
	}

	.header h3 {
		margin: 0;
		font-size: 1rem;
	}

	/* Keeps the × at the right edge when there is no title. */
	.close {
		margin-left: auto;
		display: inline-flex;
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.25rem 1.5rem;
	}
</style>
