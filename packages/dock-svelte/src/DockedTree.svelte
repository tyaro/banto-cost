<script lang="ts">
	/**
	 * Recursive renderer for the docked layout tree (M8 Phase B, spec §5.1/
	 * §5.2). One `DockedTree` instance per `DockNode`; a `split` renders its
	 * `children` as further `DockedTree` instances (self-import - each
	 * recursive level is its own component instance, so per-instance
	 * `$state` - e.g. the split's measured size for divider dragging - never
	 * leaks between siblings).
	 *
	 * `panel` and `tabs` frames are the only DRAG SOURCES and DROP TARGETS in
	 * the docked tree (a bare `split` has no rendered surface of its own -
	 * same invariant `core/tree.ts#resolveTarget` already relies on). Each
	 * such frame carries `data-dock-drop-id={node.id}` for
	 * `core/drag.svelte.ts`'s `elementFromPoint`-based hit testing.
	 *
	 * Titlebar/tab pointerdown arms a drag CANDIDATE; only once the pointer
	 * moves past `DRAG_THRESHOLD_PX` does it become a real drag (via the
	 * shared `DragController`, see `core/drag.svelte.ts`) - below that
	 * threshold a plain pointerup is just a tab click (`setActiveTab`),
	 * mirroring grid-svelte's `HeaderCell.svelte` convention. Both threshold
	 * tracking AND the split-divider resize below are sessions of the host's
	 * single `GestureOwner` (`core/gesture.svelte.ts`, shared-primitives-
	 * upstream-plan §3.3, #433): it holds the window-level listeners (rather
	 * than `setPointerCapture`, for the same reason `HeaderCell.svelte`
	 * documents - a stray double-click can wedge capture and break a later,
	 * unrelated drag), only the owning pointer moves or commits, and Esc /
	 * pointercancel / blur / unmount cancel (a tab click is not performed; a
	 * divider drag is undone).
	 *
	 * Keyboard (#433-b, shared-primitives-upstream-plan §3.3 / D5-a), read only
	 * from the focused control's own keydown (never a window listener, plan
	 * §4.3), skipping Ctrl / Alt / Meta combinations, consumed keys and IME
	 * composition:
	 *  - the divider is a WAI-ARIA Window Splitter: a focusable `separator`
	 *    whose `aria-valuenow` / `-valuemin` / `-valuemax` are the first pane's
	 *    share (in %) of the pair it separates; the arrows of its axis move it
	 *    by `KEY_STEP_FRACTION` of the split (Shift: `KEY_STEP_LARGE_FRACTION`),
	 *    Home / End to the minimum / maximum. Each press is one `divider` step
	 *    of the `GestureOwner` (`instant`): asked through `canStartGesture`,
	 *    reported to `onGestureEnd`, refused while another gesture is active.
	 *  - the tab strip uses a roving tabindex (the active tab is the one Tab
	 *    stop); Left / Right (wrapping) and Home / End select and focus a tab.
	 *
	 * "Closing" a docked pane (the ✕ button) has no first-class "hidden but
	 * still docked" state in the Phase A model (unlike a floating window's
	 * `open` flag) - a `DockPanelNode` doesn't carry one. Rather than add one,
	 * this reuses two already-existing `DockState` methods unchanged:
	 * `undockPanel` (removes it from the tree, appends it to `floating`) then
	 * `close` (marks that floating window `open: false`). The panel is fully
	 * recoverable afterwards through the same floating open/close toggle any
	 * other closed window uses - no data is lost, and no Phase A method
	 * needed changing. Since #432 the ✕ goes through the host's pane lifecycle
	 * (`core/lifecycle.ts`): `hide` for a `keepMounted` pane (the content is
	 * re-mounted in the hidden floating window, since it leaves the tree),
	 * `close` otherwise, both asked through `beforePanelChange`.
	 *
	 * Tab switches (click and arrows) are lifecycle requests too (`tab-switch`).
	 * The tab body renders each tab in its own wrapper keyed by the panel id:
	 * the active one, plus every `keepMounted` one with `hidden` + `inert`
	 * (#432, shared-primitives-upstream-plan §3.5 / D3-c), so switching tabs
	 * keeps a `keepMounted` pane's DOM. The wrapper is `display: contents`
	 * while shown, so the active tab lays out exactly as before.
	 */
	import type { Snippet } from 'svelte';
	import { pixelDeltaToFraction } from './core/geometry';
	import { MIN_PANE_FRACTION } from './core/tree';
	import { getDragController } from './core/drag.svelte';
	import { getGestureOwner } from './core/gesture.svelte';
	import { getPanelLifecycle } from './core/lifecycle';
	import { getDockPolicy, resolveCapabilities } from './core/policy';
	import type { DockState } from './state.svelte';
	import type { DockNode, PanelContent } from './types';
	import DockedTree from './DockedTree.svelte';
	import { defaultDockMessages, type DockMessages } from './messages';

	interface Props {
		node: DockNode;
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		/** Pop-out affordance (spec §5.3 v2), forwarded unchanged from `DockHost` - see its doc comment. Absent in browser mode (no button rendered). */
		onPopOut?: (content: PanelContent) => void;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings, threaded into recursive `DockedTree` instances. Defaults reproduce today's Japanese output. */
		messages?: Partial<DockMessages>;
	}

	let { node, dock, panel, onPopOut, messages = {} }: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultDockMessages, ...messages };

	const DRAG_THRESHOLD_PX = 5;
	/** Divider keyboard step (Window Splitter): a fraction of the whole split, and with Shift. */
	const KEY_STEP_FRACTION = 0.02;
	const KEY_STEP_LARGE_FRACTION = 0.1;
	const drag = getDragController();
	const gesture = getGestureOwner();
	const policy = getDockPolicy();
	const lifecycle = getPanelLifecycle();
	/** Per-pane capabilities from the host's `capabilities` prop (all allowed when absent). */
	const capsOf = (id: string) => resolveCapabilities(policy, id);

	/**
	 * Arms a drag candidate on a titlebar/tab pointerdown. `frameEl` is the
	 * pane/tabs-group frame's own element (the one carrying
	 * `data-dock-drop-id`) - its bounding rect at pointerdown time supplies
	 * both the "size to use if this becomes a floating window" and the
	 * "original grab point" the controller needs (see
	 * `core/drag.svelte.ts#DragStartOptions`). `onPlainClick` runs if the
	 * pointer never crosses the threshold (a tab-select click, or nothing for
	 * a plain panel titlebar).
	 */
	function armDrag(
		event: PointerEvent,
		frameEl: HTMLElement,
		content: PanelContent,
		onPlainClick?: () => void
	): void {
		if (event.button !== 0 || event.isPrimary === false || gesture.active) return;
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const frameRect = frameEl.getBoundingClientRect();
		// `move: false` (consumer capability): never becomes a drag, but a plain click (tab select) still works.
		const canMove = capsOf(content.id).move;
		let dragging = false;
		let refused = false;

		gesture.begin(event, {
			kind: 'drag-candidate',
			panelId: content.id,
			move(moveEvent) {
				if (dragging) {
					drag.update(moveEvent.clientX, moveEvent.clientY);
					return;
				}
				if (!canMove || refused) return;
				if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX)
					return;
				// `canStartGesture` is asked here, as `drag`; a refusal ignores the rest of the press.
				if (!gesture.setKind('drag')) {
					refused = true;
					return;
				}
				dragging = true;
				drag.start({
					panelId: content.id,
					title: content.title,
					icon: content.icon,
					source: 'docked',
					width: frameRect.width,
					height: frameRect.height,
					clientX: moveEvent.clientX,
					clientY: moveEvent.clientY,
					originClientX: frameRect.left,
					originClientY: frameRect.top
				});
			},
			commit(upEvent) {
				if (dragging) drag.commit(upEvent.clientX, upEvent.clientY);
				else if (!refused) onPlainClick?.();
			},
			cancel() {
				drag.cancel();
			}
		});
	}

	// --- split divider resize (a plain incremental pointer drag, unrelated to docking) ---
	let splitEl: HTMLDivElement | null = $state(null);

	/**
	 * A `divider` session: each owning-pointer move writes `dock.resizeSplit`
	 * live, as a fraction of the split's size read from layout at that moment
	 * (not a reactive size binding, which can lag a window resize); the release
	 * applies its own last delta the same way. Cancel (Esc / pointercancel /
	 * blur / unmount) puts back only this split's sizes from before the press (#433).
	 */
	function startDivider(
		event: PointerEvent,
		dividerIndex: number,
		direction: 'row' | 'column'
	): void {
		if (event.button !== 0 || event.isPrimary === false || gesture.active) return;
		event.preventDefault();
		const splitId = node.id;
		let last = direction === 'row' ? event.clientX : event.clientY;
		const step = (e: PointerEvent) => {
			const pos = direction === 'row' ? e.clientX : e.clientY;
			const deltaPx = pos - last;
			last = pos;
			const size = direction === 'row' ? (splitEl?.clientWidth ?? 0) : (splitEl?.clientHeight ?? 0);
			dock.resizeSplit(splitId, dividerIndex, pixelDeltaToFraction(deltaPx, size));
		};
		gesture.begin(event, {
			kind: 'divider',
			move: step,
			commit: step,
			restore: (snapshot) => dock.restoreSplitSizes(splitId, snapshot)
		});
	}

	/** A key the dock may handle: not consumed, not IME composition, no Ctrl / Alt / Meta. */
	function isPlainKey(event: KeyboardEvent): boolean {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
		return !(event.altKey || event.ctrlKey || event.metaKey);
	}

	/** The divider's Window Splitter values: the first pane's share (in %) of the pair it separates. */
	function splitterValues(sizes: number[], i: number): { now: number; min: number; max: number } {
		const pair = (sizes[i] ?? 0) + (sizes[i + 1] ?? 0);
		if (pair <= 0 || pair < 2 * MIN_PANE_FRACTION) return { now: 50, min: 50, max: 50 };
		const min = Math.round((MIN_PANE_FRACTION / pair) * 100);
		return { now: Math.round(((sizes[i] ?? 0) / pair) * 100), min, max: 100 - min };
	}

	function handleDividerKeydown(
		event: KeyboardEvent,
		dividerIndex: number,
		direction: 'row' | 'column'
	): void {
		if (node.type !== 'split' || !isPlainKey(event)) return;
		const back = direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
		const forward = direction === 'row' ? 'ArrowRight' : 'ArrowDown';
		const step = event.shiftKey ? KEY_STEP_LARGE_FRACTION : KEY_STEP_FRACTION;
		// Home / End: `resizeSplit` clamps to the pair's minimum / maximum.
		let delta: number;
		if (event.key === back) delta = -step;
		else if (event.key === forward) delta = step;
		else if (event.key === 'Home') delta = -1;
		else if (event.key === 'End') delta = 1;
		else return;
		event.preventDefault();
		const splitId = node.id;
		gesture.instant('divider', null, () => dock.resizeSplit(splitId, dividerIndex, delta));
	}

	let tabStripEl: HTMLDivElement | null = $state(null);

	function handleTabKeydown(event: KeyboardEvent, index: number): void {
		// Only the tab itself - not its nested close / pop-out buttons.
		if (node.type !== 'tabs' || event.target !== event.currentTarget || !isPlainKey(event)) return;
		const count = node.children.length;
		let next: number;
		if (event.key === 'ArrowRight') next = (index + 1) % count;
		else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else return;
		event.preventDefault();
		const to = node.children[next]?.id;
		if (to === undefined) return;
		// Focus follows only once the switch is applied (it may be refused or held).
		void lifecycle.switchTab(node.id, to, () => {
			// The tabs are keyed by id, so the element already exists.
			const tabs = tabStripEl?.querySelectorAll<HTMLElement>('[role="tab"]');
			const target = [...(tabs ?? [])].find((el) => el.dataset.dockTabId === to);
			target?.focus();
		});
	}

	let panelFrameEl: HTMLDivElement | null = $state(null);
	let tabsFrameEl: HTMLDivElement | null = $state(null);
</script>

{#if node.type === 'panel'}
	<div
		class="dock-pane"
		data-dock-drop-id={node.id}
		bind:this={panelFrameEl}
		role="group"
		aria-label={node.title}
	>
		<!--
			role="toolbar": this is a drag handle wrapping a real close/pop-out
			<button> group, not a button itself - `role="button"` here would trip
			axe's nested-interactive rule (a `button`-rolled element's children
			are ARIA-presentational, which conflicts with the nested buttons being
			real, operable controls). `toolbar` is a plain grouping role (no
			`childrenPresentational`) that still requires (and gets, via
			`aria-label`) an accessible name, without claiming to itself be a
			single interactive control. Dragging stays pointer-only (see the
			module doc comment); the close/pop-out buttons remain the keyboard
			entry points. Not itself put in the tab order (no roving-tabindex
			management here, unlike a "real" toolbar's expected keyboard model) -
			svelte-ignore below, since axe has no equivalent complaint (a toolbar
			isn't required to be focusable itself, only its interactive children
			are, and they already are).
		-->
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			class="titlebar"
			role="toolbar"
			aria-label={node.title}
			onpointerdown={(event) => panelFrameEl && armDrag(event, panelFrameEl, node)}
		>
			{#if node.icon}
				<span class="icon" aria-hidden="true">{node.icon}</span>
			{/if}
			<span class="title">{node.title}</span>
			{#if onPopOut && capsOf(node.id).undock}
				<button
					type="button"
					class="popout-btn"
					aria-label={t.popOut(node.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => onPopOut?.(node)}
				>
					⧉
				</button>
			{/if}
			{#if capsOf(node.id).close}
				<button
					type="button"
					class="close-btn"
					aria-label={t.close(node.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => void lifecycle.closeButton(node.id)}
				>
					✕
				</button>
			{/if}
		</div>
		<!-- role="region" + tabindex="0": the pane's content can overflow and
		     scroll, and axe's scrollable-region-focusable rule requires a
		     scrollable region to be reachable (and thus scrollable) via
		     keyboard, not just pointer/wheel. Svelte's own a11y check disagrees
		     (a landmark role "shouldn't" carry tabindex) - this is the
		     WAI-ARIA-recognized scrollable-region pattern axe itself expects,
		     so the svelte-check warning is the one to suppress. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="body" role="region" aria-label={node.title} tabindex="0">
			{@render panel(node)}
		</div>
	</div>
{:else if node.type === 'tabs'}
	{@const active = node.children[node.activeIndex]}
	<div
		class="dock-pane"
		data-dock-drop-id={node.id}
		bind:this={tabsFrameEl}
		role="group"
		aria-label={active?.title}
	>
		<!--
			Each `.tab` keeps `role="tab"` (required by the `tablist`/`tab` ARIA
			pattern) even though - like the plain-panel titlebar above - the
			active tab nests real close/pop-out <button>s, which is technically
			the same nested-interactive shape axe flags there. Unlike the
			titlebar, `tab` can't be swapped for a non-interactive grouping role
			without giving up tab semantics entirely, and splitting the buttons
			out of the DOM subtree would be a real restructure, not a role/aria
			tweak. Left as-is: no docked layout in this app ever starts (or is
			driven to, in the scanned flows) a tabbed group, so this shape is
			never exercised by the axe scan in `e2e/visual/a11y.spec.ts` - flagged
			here for whoever next touches tab-strip interaction/keyboard support.
		-->
		<div class="tab-strip" role="tablist" bind:this={tabStripEl}>
			{#each node.children as child, i (child.id)}
				<div
					class="tab"
					class:active={i === node.activeIndex}
					role="tab"
					data-dock-tab-id={child.id}
					tabindex={i === node.activeIndex ? 0 : -1}
					aria-selected={i === node.activeIndex}
					aria-label={child.title}
					onpointerdown={(event) =>
						tabsFrameEl &&
						armDrag(event, tabsFrameEl, child, () => void lifecycle.switchTab(node.id, child.id))}
					onkeydown={(event) => handleTabKeydown(event, i)}
				>
					{#if child.icon}
						<span class="icon" aria-hidden="true">{child.icon}</span>
					{/if}
					<span class="title">{child.title}</span>
					{#if i === node.activeIndex}
						{#if onPopOut && capsOf(child.id).undock}
							<button
								type="button"
								class="popout-btn"
								aria-label={t.popOut(child.title)}
								onpointerdown={(event) => event.stopPropagation()}
								onclick={() => onPopOut?.(child)}
							>
								⧉
							</button>
						{/if}
						{#if capsOf(child.id).close}
							<button
								type="button"
								class="close-btn"
								aria-label={t.close(child.title)}
								onpointerdown={(event) => event.stopPropagation()}
								onclick={() => void lifecycle.closeButton(child.id)}
							>
								✕
							</button>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
		<!-- Same scrollable-region-focusable rationale (and svelte-ignore) as the `panel` branch's `.body` above. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="body" role="region" aria-label={active?.title} tabindex="0">
			{#each node.children as child, i (child.id)}
				{@const shown = i === node.activeIndex}
				{#if shown || lifecycle.keepMounted(child.id)}
					<div class="tab-content" hidden={!shown} inert={!shown}>
						{@render panel(child)}
					</div>
				{/if}
			{/each}
		</div>
	</div>
{:else}
	<div
		class="dock-split"
		class:row={node.direction === 'row'}
		class:column={node.direction === 'column'}
		bind:this={splitEl}
	>
		{#each node.children as child, i (child.id)}
			<div class="split-child" style:flex-grow={node.sizes[i] ?? 0} style:flex-basis="0%">
				<DockedTree node={child} {dock} {panel} {onPopOut} {messages} />
			</div>
			{#if i < node.children.length - 1}
				{@const values = splitterValues(node.sizes, i)}
				<!-- A focusable separator is an interactive widget (WAI-ARIA Window Splitter, #433-b). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="divider"
					class:row={node.direction === 'row'}
					class:column={node.direction === 'column'}
					role="separator"
					tabindex="0"
					aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
					aria-label={t.resizeHandle()}
					aria-valuenow={values.now}
					aria-valuemin={values.min}
					aria-valuemax={values.max}
					onpointerdown={(event) => startDivider(event, i, node.direction)}
					onkeydown={(event) => handleDividerKeydown(event, i, node.direction)}
				></div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.dock-pane {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		background: var(--banto-surface);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.titlebar {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		height: var(--banto-dock-titlebar-height);
		padding: 0 0.4rem 0 0.7rem;
		background: var(--banto-surface-raised);
		border-bottom: 1px solid var(--banto-border);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--banto-text);
		user-select: none;
		touch-action: none;
		cursor: move;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.titlebar:hover {
		background: var(--banto-surface-hover);
	}

	/* A layout no-op while shown (the active tab lays out as before #432). */
	.tab-content {
		display: contents;
	}

	.tab-content[hidden] {
		display: none;
	}

	.tab-strip {
		flex: 0 0 auto;
		display: flex;
		align-items: stretch;
		height: var(--banto-dock-titlebar-height);
		background: var(--banto-surface-raised);
		border-bottom: 1px solid var(--banto-border);
		overflow-x: auto;
		overflow-y: hidden;
	}

	.tab {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0 0.5rem 0 0.7rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--banto-text-muted);
		border-right: 1px solid var(--banto-border);
		user-select: none;
		touch-action: none;
		cursor: pointer;
		max-width: 12rem;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.tab:hover:not(.active) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.tab.active {
		color: var(--banto-text);
		background: var(--banto-dock-tab-active-bg);
		box-shadow: inset 0 -2px 0 var(--banto-primary);
	}

	.icon {
		flex: 0 0 auto;
		font-size: 0.9rem;
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.close-btn,
	.popout-btn {
		flex: 0 0 auto;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		font-size: 0.7rem;
		touch-action: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.close-btn:hover {
		background: color-mix(in srgb, var(--banto-danger) 15%, transparent);
		color: var(--banto-danger);
	}

	.popout-btn:hover {
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		color: var(--banto-primary);
	}

	.close-btn:focus-visible,
	.popout-btn:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: auto;
		background: var(--banto-surface);
	}

	.body:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.dock-split {
		display: flex;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}

	.dock-split.row {
		flex-direction: row;
	}

	.dock-split.column {
		flex-direction: column;
	}

	.split-child {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.divider {
		flex: 0 0 auto;
		background: var(--banto-dock-divider);
		touch-action: none;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.divider:hover {
		background: var(--banto-dock-divider-hover);
	}

	.divider:focus-visible {
		outline: none;
		background: var(--banto-dock-divider-hover);
		box-shadow: var(--banto-focus-ring);
	}

	.divider.row {
		width: 6px;
		cursor: col-resize;
	}

	.divider.column {
		height: 6px;
		cursor: row-resize;
	}
</style>
