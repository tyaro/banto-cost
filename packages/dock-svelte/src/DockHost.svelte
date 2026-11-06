<script lang="ts">
	/**
	 * Host container for the whole dock layout (spec §5.2/§5.3). Measures
	 * itself via `bind:clientWidth`/`bind:clientHeight` (same plain-reactive-
	 * binding pattern as @banto/charts' ChartContainer.svelte - no separate
	 * ResizeObserver wiring needed).
	 *
	 * Two layers, in DOM/paint order (M8 Phase B adds the first):
	 *  1. The docked tree (`DockedTree`, if `dock.layout.docked` isn't
	 *     `null`) filling the whole host.
	 *  2. Every OPEN floating window (`dock.layout.floating`, M7), absolutely
	 *     positioned on top inside a pointer-transparent floating layer. The
	 *     array order is still the z-order (last = frontmost, which is what is
	 *     saved), but it is applied as `z-index`; the DOM order is the order in
	 *     which windows were first seen and never changes when a window is
	 *     raised (#433, shared-primitives-upstream-plan §3.3: raising on
	 *     `focusin` must not move the focused element - moving a node drops its
	 *     focus in browsers - nor reshuffle the Tab order). When `docked` is
	 *     `null` the host looks exactly like it did before Phase B.
	 * The `panel` snippet receives a `PanelContent` (id/title/icon) so a
	 * docked pane and a floating window can share the exact same content -
	 * DockHost itself has no notion of what a panel contains.
	 *
	 * DockHost owns the single `DragController` (`core/drag.svelte.ts`) for
	 * the whole tree - both `DockedTree` panes/tabs and `DockWindow`
	 * titlebars start a drag through it (via Svelte context, `setContext` in
	 * this file / `getContext` in theirs) - and renders the drag ghost +
	 * snap-guide overlay here, on top of everything else, from the
	 * controller's reactive `state` snapshot. Both the ghost and the guide
	 * are `pointer-events: none`: `core/drag.svelte.ts` hit-tests drop
	 * targets with `elementFromPoint`, so anything that could occlude the
	 * real target under the cursor would break that.
	 *
	 * DockHost also owns the single `GestureOwner` (`core/gesture.svelte.ts`,
	 * #433): every pointer gesture of the tree (title-bar / tab drag, floating
	 * resize, split divider) is one session of it - one at a time, only the
	 * owning pointer commits, Esc / pointercancel / blur / hidden cancel - and
	 * unmounting the host cancels the active session (undoing only that
	 * gesture's own target) and removes its listeners. The keyboard paths
	 * (#433-b, shared-primitives-upstream-plan §3.3 / D5) are sessions of the
	 * same owner, and the three gesture hooks below (`canStartGesture`,
	 * `onGestureEnd`, `isEscapeBlocked`) are passed to it through getters, so
	 * they always read the live props.
	 *
	 * DockHost also owns the single `PanelLifecycle` (`core/lifecycle.ts`, #432,
	 * shared-primitives-upstream-plan §3.5 / §4.2 / D3-c / D4): every structure
	 * change of the dock UI (dock / undock / move a docked pane / tab switch /
	 * hide / close) asks `beforePanelChange` first and waits for an IME
	 * composition to end; the content of `keepMounted` panes stays mounted
	 * (`hidden` + `inert`) while their tab is not shown or their floating window
	 * is hidden - those hidden windows are rendered here too. The ✕ button hides
	 * a `keepMounted` pane and closes (discards) any other; `hidePanel` /
	 * `closePanel` below are the same two actions for an app's own UI.
	 *
	 * Which guard applies first (README "Pane lifecycle"): `capabilities` decide
	 * whether the control exists at all (no ✕, no drag); then a `drag` does not
	 * start while `isStructureChangeDeferred()` is true; then `canStartGesture`
	 * may refuse the gesture; then `beforePanelChange` decides, when the gesture
	 * commits (after the gesture closed) or a button is pressed, whether the
	 * layout changes.
	 */
	import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
	import { createDragController, setDragController } from './core/drag.svelte';
	import {
		GestureOwner,
		setGestureOwner,
		type GestureCancelReason as DockCancelReason,
		type GestureKind as DockGestureKind
	} from './core/gesture.svelte';
	import type { ClampOptions } from './core/geometry';
	import {
		PanelLifecycle,
		setPanelLifecycle,
		type DockPanelChange,
		type DockPanelChangeOutcome
	} from './core/lifecycle';
	import { collectPanelIds } from './core/tree';
	import { setDockPolicy, type DockCapabilities, type DockPolicy } from './core/policy';
	import type { DockState } from './state.svelte';
	import type { PanelContent } from './types';
	import DockedTree from './DockedTree.svelte';
	import DockWindow from './DockWindow.svelte';
	import type { DockMessages } from './messages';

	interface Props {
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		/**
		 * Optional pop-out affordance (spec §5.3 v2: "ウィンドウ分離"モード).
		 * When provided, both `DockWindow` titlebars and `DockedTree` pane
		 * titlebars/tab strips render an extra ⧉ button BEFORE the close
		 * button, calling this with that panel's `PanelContent` on click. This
		 * package has zero Tauri knowledge and no opinion on what "popping
		 * out" means - it just forwards the click. The caller (the app) is
		 * expected to hide/undock the panel and open a real native window for
		 * it, then call `dock.open(id)` again once that window closes -
		 * see apps/admin-template's dashboard page for the reference wiring.
		 * When this prop is omitted (e.g. plain-browser mode), nothing extra
		 * renders at all - zero layout/behavior change from before this prop
		 * existed.
		 */
		onPopOut?: (content: PanelContent) => void;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings, threaded down to `DockedTree` and `DockWindow`. Defaults reproduce today's Japanese output. */
		messages?: Partial<DockMessages>;
		/**
		 * Clamp policy for floating windows (shared-primitives-upstream-plan §3.2,
		 * #434): minimum size, px that must stay visible, and what to do when the
		 * host is narrower than the minimum. Omitted = the package's generic
		 * defaults (`DEFAULT_MIN_*`); an app passes its own numbers. It is applied
		 * when DRAWING (the saved x/y/width/height are not rewritten, so a host
		 * that shrinks and grows back restores the preferred placement) and when
		 * the user moves/resizes (the result then becomes the new preference).
		 */
		clamp?: ClampOptions;
		/**
		 * Per-pane capabilities (close / move / undock; default all allowed). For
		 * a pane an app must keep, such as a central canvas:
		 * `(id) => (id === 'canvas' ? { close: false, move: false } : undefined)`.
		 * UI affordances only - see `DockCapabilities`.
		 */
		capabilities?: (panelId: string) => DockCapabilities | undefined;
		/**
		 * May this gesture start (exclusion with drawing, another DnD or a higher
		 * layer; shared-primitives-upstream-plan §3.3, #433)? `false` = it does
		 * not start: nothing moves, no listener is added, `onGestureEnd` is not
		 * called. `panelId` is the window / pane's id, `null` for a divider. A
		 * title-bar or tab press is asked as `drag` once it crosses the drag
		 * threshold (until then it may still be a plain click - a tab selection -
		 * and is not asked); a refused drag ignores the rest of that press.
		 * Omitted = always allowed.
		 */
		canStartGesture?: (kind: DockGestureKind, panelId: string | null) => boolean;
		/**
		 * Called exactly once when a gesture ends, after the layout reflects the
		 * outcome (committed, or the target restored): `commit`, or `cancel` with
		 * the reason. Also called with `drag-candidate` / `commit` for a press
		 * that never became a drag (a click), and with `divider` / `commit` for
		 * each keyboard step on a divider. The gesture is already closed, so the
		 * hook may start another one or unmount the host.
		 */
		onGestureEnd?: (
			kind: DockGestureKind,
			outcome: 'commit' | 'cancel',
			reason?: DockCancelReason
		) => void;
		/**
		 * Must the dock leave this Esc alone (`true` = yield it to a higher layer;
		 * shared-primitives-upstream-plan §3.3 / §4.3)? Asked only while a gesture
		 * is active and the Esc was not already consumed (`defaultPrevented`) nor
		 * part of IME composition. `activeLayer` is the gesture's floating window
		 * root (`role="dialog"`), `null` for a docked pane or a divider. Every
		 * floating window is a NON-modal `role="dialog"`, so a check that counts
		 * any dialog counts the gesture's own window (and, for a divider, any open
		 * floating window) and Esc never cancels. With `@banto/ui` an app passes
		 * `(el) => el ? hasVisibleLayerAbove({ except: el }) : hasVisibleModalLayer() || hasVisibleMenuLayer()`.
		 * Omitted = only `defaultPrevented` is honoured.
		 */
		isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean;
		/**
		 * Asked before every structure change the dock UI makes (shared-primitives-
		 * upstream-plan §3.5, #432): a drop that docks / undocks / moves a docked
		 * pane, a tab switch, a hide and a close. Only `true` (or a promise that
		 * resolves to `true`) lets it through; anything else - `false`, a throw, a
		 * rejection - leaves the layout as it is. The app shows its own confirm UI.
		 * An async answer is applied only if the layout's structure did not change
		 * while it was pending, and never after the host unmounted. Geometry-only
		 * changes (move / resize, dividers) and the app's own `DockState` calls
		 * are not asked. Omitted = always allowed.
		 */
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		/**
		 * Panes whose content stays mounted - `hidden` + `inert`, the same DOM
		 * nodes - while their tab is not the active one or their floating window
		 * is hidden (D3-c): IME state, selection, scroll and unfinished input
		 * survive. For such a pane the ✕ button HIDES (D4-a); `closePanel`
		 * discards the content. Moving between the docked tree and the floating
		 * layer (dock / undock) still re-mounts. Omitted = none (today's behaviour).
		 */
		keepMounted?: (panelId: string) => boolean;
		/**
		 * `true` = hold structure changes now (shared-primitives-upstream-plan §3.5 /
		 * §4.2): a `drag` does not start, and a requested change waits - it is
		 * asked and applied after the next `compositionend` / `focusout` on the
		 * document (or `resumeDeferredChange()`). Omitted = an IME composition is
		 * in progress in the document.
		 */
		isStructureChangeDeferred?: () => boolean;
	}

	let {
		dock,
		panel,
		onPopOut,
		messages = {},
		clamp,
		capabilities,
		canStartGesture,
		onGestureEnd,
		isEscapeBlocked,
		beforePanelChange,
		keepMounted,
		isStructureChangeDeferred
	}: Props = $props();

	// Published through context; getters keep reading the live props.
	const policy: DockPolicy = {
		get clamp() {
			return clamp;
		},
		get capabilities() {
			return capabilities;
		}
	};
	setDockPolicy(policy);

	let hostW: number = $state(0);
	let hostH: number = $state(0);
	let hostEl: HTMLDivElement | null = $state(null);

	// svelte-ignore state_referenced_locally
	const lifecycle = new PanelLifecycle(dock, () => ({
		beforePanelChange,
		keepMounted,
		isStructureChangeDeferred
	}));
	setPanelLifecycle(lifecycle);
	onMount(() => lifecycle.attach());
	onDestroy(() => lifecycle.dispose());

	const openWindows = $derived(dock.layout.floating.filter((w) => w.open));
	/** Open windows plus hidden ones whose content is kept (`keepMounted`, not discarded by `close`). */
	const mountedWindows = $derived(
		dock.layout.floating.filter((w) => w.open || lifecycle.isRetained(w.id))
	);
	// A pane shown again (open floating or docked) is kept again by a later hide.
	$effect(() => {
		const shown = [...openWindows.map((w) => w.id), ...collectPanelIds(dock.layout.docked)];
		untrack(() => lifecycle.forgetDiscarded(shown));
	});

	// Stable DOM order (see the module doc): the first time an id is seen it
	// gets the next sequence number and keeps it. A plain Map, not state - it
	// only ever grows, and nothing reacts to it directly.
	const domSeq = new Map<string, number>();
	const renderedWindows = $derived.by(() => {
		for (const w of mountedWindows) if (!domSeq.has(w.id)) domSeq.set(w.id, domSeq.size);
		return [...mountedWindows].sort((a, b) => (domSeq.get(a.id) ?? 0) - (domSeq.get(b.id) ?? 0));
	});
	/** id → stacking position (index in `layout.floating`'s open windows = z-order). */
	const zOrder = $derived(new Map(openWindows.map((w, i) => [w.id, i])));

	// `dock` is a stable DockState instance for this component's lifetime, so
	// capturing it once to build the drag controller is intentional.
	// svelte-ignore state_referenced_locally
	const drag = createDragController(
		dock,
		() => hostEl,
		() => policy,
		() => lifecycle
	);
	setDragController(drag);

	// svelte-ignore state_referenced_locally
	const gesture = new GestureOwner(
		dock,
		() => hostEl,
		() => ({
			// A `drag` may end in dock / undock: not started while structure changes are held (IME).
			canStart: (kind, panelId) =>
				!(kind === 'drag' && lifecycle.isDeferred()) &&
				(canStartGesture ? canStartGesture(kind, panelId) : true),
			isEscapeBlocked,
			onEnd: (session, outcome, reason) => onGestureEnd?.(session.kind, outcome, reason)
		})
	);
	setGestureOwner(gesture);
	onDestroy(() => gesture.dispose());

	/**
	 * Hide a pane through `beforePanelChange` (`hide`): a `keepMounted` floating
	 * window keeps its content mounted (`hidden` + `inert`); a docked pane
	 * becomes a closed floating window (re-mounted). Geometry is kept.
	 */
	export function hidePanel(panelId: string): Promise<DockPanelChangeOutcome> {
		return lifecycle.hide(panelId);
	}

	/**
	 * Close a pane through `beforePanelChange` (`close`): its content is
	 * discarded even when `keepMounted`, until the pane is opened again.
	 * Geometry is kept.
	 */
	export function closePanel(panelId: string): Promise<DockPanelChangeOutcome> {
		return lifecycle.close(panelId);
	}

	/** Retry a change held by `isStructureChangeDeferred` now (a custom predicate turned false without a composition / focus event). */
	export function resumeDeferredChange(): void {
		lifecycle.resumeDeferred();
	}
</script>

<div
	class="dock-host"
	data-dock-host
	bind:this={hostEl}
	bind:clientWidth={hostW}
	bind:clientHeight={hostH}
>
	{#if dock.layout.docked}
		<div class="docked-layer">
			<DockedTree node={dock.layout.docked} {dock} {panel} {onPopOut} {messages} />
		</div>
	{/if}

	<div class="floating-layer">
		{#each renderedWindows as win (win.id)}
			{@const z = zOrder.get(win.id) ?? 0}
			<DockWindow
				{win}
				{dock}
				{hostW}
				{hostH}
				hidden={!win.open}
				frontmost={win.open && z === openWindows.length - 1}
				zIndex={z + 1}
				{panel}
				{onPopOut}
				{messages}
			/>
		{/each}
	</div>

	{#if drag.state}
		{#if drag.state.guideRect}
			<div
				class="snap-guide"
				aria-hidden="true"
				style:left={`${drag.state.guideRect.x}px`}
				style:top={`${drag.state.guideRect.y}px`}
				style:width={`${drag.state.guideRect.width}px`}
				style:height={`${drag.state.guideRect.height}px`}
			></div>
		{/if}
		<div
			class="drag-ghost"
			aria-hidden="true"
			style:left={`${drag.state.clientX}px`}
			style:top={`${drag.state.clientY}px`}
		>
			{#if drag.state.icon}<span class="icon">{drag.state.icon}</span>{/if}
			<span class="title">{drag.state.title}</span>
		</div>
	{/if}
</div>

<style>
	.dock-host {
		position: relative;
		overflow: hidden;
		width: 100%;
		height: 100%;
		background: var(--banto-bg);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
	}

	.docked-layer {
		position: absolute;
		inset: 0;
	}

	/* Its own stacking context (z-index 1) so the windows' z-index (1..n) stays
	   below the snap guide / ghost and never competes with the page; it lets
	   pointers through to the docked tree, the windows opt back in. */
	.floating-layer {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
	}

	/* Snap guide follows the pointer every move - no transition, it must track instantly. */
	.snap-guide {
		position: absolute;
		background: var(--banto-dock-snap-fill);
		border: 2px solid var(--banto-dock-snap-border);
		border-radius: var(--banto-radius-md);
		box-sizing: border-box;
		pointer-events: none;
		z-index: 20;
	}

	/* Drag ghost follows the pointer every move - no transition, same reason as .snap-guide. */
	.drag-ghost {
		position: fixed;
		transform: translate(14px, 14px);
		display: flex;
		align-items: center;
		gap: 0.35rem;
		max-width: 16rem;
		padding: 0.35rem 0.65rem;
		background: var(--banto-dock-ghost-bg);
		border: 1px solid var(--banto-dock-ghost-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-dock-shadow);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--banto-text);
		pointer-events: none;
		z-index: 30;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
