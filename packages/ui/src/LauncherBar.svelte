<script lang="ts">
	/**
	 * Dock-like icon launcher (docs/design/nav-launcher-plan.md §4;
	 * docs/adr/0018-shared-ui-package.md §11, phase 5). Presentation and
	 * interaction only: the caller builds the groups (routing, `active`, RBAC,
	 * badges and every text) and loads `@banto/theme/css`.
	 *
	 * - One `<nav aria-label>` per group with a rule between groups (§4.5); the
	 *   items are plain `<a href>` in the Tab order (§4.7), `aria-current="page"`
	 *   when active (§4.3). The accessible name is real, visually hidden text
	 *   (label + badge label) - not `aria-label`, so voice control can say the
	 *   label, and no `title` (it would double the tooltip) (§4.4).
	 * - Magnification (§4.2): mouse `pointermove`, throttled to one
	 *   `requestAnimationFrame`, sets a per-item `--_scale`; the item's *size*
	 *   (not a transform) follows, so neighbours move aside and the bar grows.
	 *   Off under `prefers-reduced-motion` (on top of the 0ms duration tokens),
	 *   `(hover: none)`, <=900px and for non-mouse pointers; never on focus.
	 * - Tooltip (§4.4, WCAG 1.4.13): a child of the item's `<li>`, shown on the
	 *   `<li>`'s hover or the link's `:focus-visible`, hoverable across a
	 *   transparent bridge, `aria-hidden`. Esc hides it wherever focus is, via
	 *   a `window` listener that exists only while a tooltip is shown; it yields
	 *   to any visible layer above (`hasVisibleLayerAbove()`) and to handled
	 *   events, and never consumes the event (the shell's Esc stays intact).
	 * - Position (§4.1, D4): `bottom` floats centred above the bottom edge;
	 *   `top` is its mirror below the top edge, under the room the shell
	 *   keeps for its header (`--banto-shell-launcher-inset-top`), growing
	 *   downwards with the tooltips below the items;
	 *   `left` / `right` are a vertical bar centred on that edge, magnifying
	 *   along the vertical axis and growing towards the page, with the
	 *   tooltips beside the items on the page side.
	 * - <=900px (§4.6, D5): a full-width bottom tab bar with small captions and
	 *   44px minimum targets, scrolling sideways when the items do not fit -
	 *   whatever the `position` (the vertical rules only apply above 900px).
	 */
	import { onMount, untrack } from 'svelte';
	import { hasVisibleLayerAbove } from './layering';
	import {
		LAUNCHER_MAGNIFY_RANGE_ITEMS,
		magnifyScale,
		type LauncherGroup,
		type LauncherPosition
	} from './launcher';

	interface Props {
		groups: LauncherGroup[];
		/** `'bottom'` (default), `'top'`, `'left'` or `'right'` (nav-launcher-plan.md D4); <=900px is always the bottom tab bar. */
		position?: LauncherPosition;
		/** Magnify on mouse hover (D6); still off under reduced motion, touch and <=900px. */
		magnify?: boolean;
		/** Optional name for the whole bar (it becomes a `role="group"`); each group's `<nav>` has its own. */
		ariaLabel?: string;
	}

	let { groups, position = 'bottom', magnify = true, ariaLabel }: Props = $props();

	const MAGNIFY_MAX_TOKEN = '--banto-shell-launcher-magnify-max';
	const ITEM_SIZE_TOKEN = '--banto-shell-launcher-item-size';

	let bar: HTMLElement | undefined = $state();
	/** The fixed root: its z-index (--banto-z-launcher) is what "a layer above" is measured against. */
	let root: HTMLElement | undefined = $state();

	/** Left / right: the main axis (magnification, scrolling) is vertical. */
	const vertical = $derived(position === 'left' || position === 'right');

	// --- environment (media queries, followed on `change`) -------------------
	let reducedMotion = $state(false);
	let hoverNone = $state(false);
	let narrow = $state(false);

	const magnifyActive = $derived(magnify && !reducedMotion && !hoverNone && !narrow);

	// --- magnification -------------------------------------------------------
	/** Per-item scale; an item without an entry falls back to `var(--_scale, 1)`. */
	let scales: Record<string, number> = $state({});
	let pointerMain: number | null = null;
	let frame = 0;
	/** Token values read once per hover (null = not read yet). */
	let metrics: { max: number; range: number } | null = null;

	function readMetrics(el: HTMLElement): { max: number; range: number } {
		const style = getComputedStyle(el);
		const max = Number.parseFloat(style.getPropertyValue(MAGNIFY_MAX_TOKEN));
		const size = Number.parseFloat(style.getPropertyValue(ITEM_SIZE_TOKEN));
		// Unreadable tokens: max 1 = no magnification (plan §5.2, safe side).
		return {
			max: Number.isFinite(max) ? max : 1,
			range: Number.isFinite(size) ? size * LAUNCHER_MAGNIFY_RANGE_ITEMS : 0
		};
	}

	function resetMagnify(): void {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		pointerMain = null;
		metrics = null;
		if (Object.keys(scales).length > 0) scales = {};
	}

	function applyMagnify(): void {
		frame = 0;
		if (!bar || pointerMain === null || !magnifyActive) return;
		metrics ??= readMetrics(bar);
		const { max, range } = metrics;
		const next: Record<string, number> = {};
		if (max > 1 && range > 0) {
			for (const el of bar.querySelectorAll<HTMLElement>('[data-launcher-item]')) {
				const rect = el.getBoundingClientRect();
				const centre = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
				const scale = magnifyScale(pointerMain - centre, range, max);
				if (scale > 1) next[el.dataset.launcherItem ?? ''] = Math.round(scale * 1000) / 1000;
			}
		}
		scales = next;
	}

	function onPointerMove(event: PointerEvent): void {
		if (event.pointerType !== 'mouse' || !magnifyActive) return;
		pointerMain = vertical ? event.clientY : event.clientX;
		if (!frame) frame = requestAnimationFrame(applyMagnify);
	}

	// Reduced motion / narrow / magnify={false} switched on mid-hover: drop the scales.
	$effect(() => {
		if (!magnifyActive) untrack(resetMagnify);
	});

	// --- tooltip (§4.4) --------------------------------------------------------
	// The bottom bar's track scrolls sideways, so it clips anything past its
	// small inline padding: the outermost items' tooltips align to the item's
	// outer edge instead of centring on it, so a long label grows inwards
	// (#423 review). A vertical bar's tooltip sits beside the item and is
	// shorter than it, so the CSS keeps those centred (the classes stay).
	const allIds = $derived(groups.flatMap((group) => group.items.map((item) => item.id)));
	const firstId = $derived(allIds[0]);
	const lastId = $derived(allIds.at(-1));

	let hoveredId: string | null = $state(null);
	let focusId: string | null = $state(null);
	/** Items whose tooltip Esc hid: until the pointer leaves / focus moves. */
	let quietHover: string | null = $state(null);
	let quietFocus: string | null = $state(null);

	const isQuiet = (id: string): boolean => id === quietHover || id === quietFocus;
	const tooltipShown = $derived(
		(hoveredId !== null && !isQuiet(hoveredId)) || (focusId !== null && !isQuiet(focusId))
	);

	function onItemEnter(event: PointerEvent, id: string): void {
		if (event.pointerType === 'touch') return;
		hoveredId = id;
	}

	function onItemLeave(id: string): void {
		if (hoveredId === id) hoveredId = null;
		if (quietHover === id) quietHover = null;
	}

	function isFocusVisible(el: Element): boolean {
		try {
			return el.matches(':focus-visible');
		} catch {
			return true; // engines without the selector: treat focus as visible
		}
	}

	function onLinkFocus(event: FocusEvent, id: string): void {
		quietFocus = null;
		focusId =
			event.currentTarget instanceof Element && isFocusVisible(event.currentTarget) ? id : null;
	}

	function onLinkBlur(id: string): void {
		if (focusId === id) focusId = null;
		quietFocus = null;
	}

	$effect(() => {
		if (!tooltipShown) return;
		const onKeydown = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			// A palette / Modal / Drawer / menu above us owns this Esc (layering.ts promise 2).
			// Measured against the bar's own z-index: a non-modal window inside
			// the page (the dashboard's floating DockHost panel, role="dialog")
			// sits below the bar and must not swallow the tooltip's Esc.
			if (hasVisibleLayerAbove({ except: root })) return;
			// No preventDefault / stopPropagation: the shell may still act on it.
			quietHover = hoveredId;
			quietFocus = focusId;
		};
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	onMount(() => {
		const cleanups: (() => void)[] = [];
		if (typeof window.matchMedia === 'function') {
			const follow = (query: string, set: (matches: boolean) => void): void => {
				const list = window.matchMedia(query);
				set(list.matches);
				const onChange = (event: MediaQueryListEvent): void => set(event.matches);
				list.addEventListener?.('change', onChange);
				cleanups.push(() => list.removeEventListener?.('change', onChange));
			};
			follow('(prefers-reduced-motion: reduce)', (v) => (reducedMotion = v));
			follow('(hover: none)', (v) => (hoverNone = v));
			// Same breakpoint as the shell (nav-launcher-plan.md §4.6).
			follow('(max-width: 900px)', (v) => (narrow = v));
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		};
	});
</script>

<div
	bind:this={root}
	class="launcher launcher--{position}"
	class:launcher--vertical={vertical}
	class:launcher--magnifying={Object.keys(scales).length > 0}
	role={ariaLabel ? 'group' : undefined}
	aria-label={ariaLabel}
>
	<div class="launcher__track">
		<!-- Pointer tracking for the magnification only (mouse, visual): the
		     links inside stay the interactive, keyboard-reachable elements. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="launcher__bar"
			bind:this={bar}
			onpointermove={onPointerMove}
			onpointerleave={resetMagnify}
		>
			{#each groups as group, index (group.id)}
				{#if index > 0}
					<div class="launcher__separator" aria-hidden="true"></div>
				{/if}
				<nav class="launcher__group" aria-label={group.ariaLabel}>
					<ul class="launcher__list">
						{#each group.items as item (item.id)}
							{@const Icon = item.icon}
							<li
								class="launcher__item"
								class:launcher__item--quiet={isQuiet(item.id)}
								class:launcher__item--first={item.id === firstId}
								class:launcher__item--last={item.id === lastId && item.id !== firstId}
								data-launcher-item={item.id}
								style:--_scale={scales[item.id]}
								onpointerenter={(event) => onItemEnter(event, item.id)}
								onpointerleave={() => onItemLeave(item.id)}
							>
								<a
									class="launcher__link"
									class:launcher__link--active={item.active}
									href={item.href}
									aria-current={item.active ? 'page' : undefined}
									onfocus={(event) => onLinkFocus(event, item.id)}
									onblur={() => onLinkBlur(item.id)}
								>
									<span class="launcher__icon"><Icon size={24} aria-hidden="true" /></span>
									<span class="launcher__caption" aria-hidden="true">{item.label}</span>
									{#if item.badge}
										<span class="launcher__badge" aria-hidden="true">{item.badge.text}</span>
									{/if}
									<span class="launcher__name"
										>{item.badge ? `${item.label} ${item.badge.label}` : item.label}</span
									>
								</a>
								<span class="launcher__tooltip" aria-hidden="true">{item.label}</span>
							</li>
						{/each}
					</ul>
				</nav>
			{/each}
		</div>
	</div>
</div>

<style>
	.launcher {
		position: fixed;
		z-index: var(--banto-z-launcher);
		display: flex;
		justify-content: center;
		/* The wrapper and the track only make room (tooltips, shadow); clicks
		   pass through to the page except on the bar itself. */
		pointer-events: none;
	}

	.launcher--bottom {
		inset-inline: 0;
		bottom: 0;
	}

	.launcher__track {
		max-width: 100%;
		/* Many items scroll sideways inside the track. The track's top padding
		   is the tooltips' room (an overflow box clips its children); the
		   offset padding keeps the bar off the screen edge with room for its
		   shadow. */
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
		padding: 2.5rem var(--banto-shell-launcher-offset) var(--banto-shell-launcher-offset);
		pointer-events: none;
	}

	.launcher__bar {
		display: flex;
		align-items: flex-end;
		gap: var(--banto-shell-launcher-gap);
		width: max-content;
		padding: var(--banto-shell-launcher-padding);
		position: relative;
		/* Own stacking context for the ::before backdrop below (z-index: -1)
		   without making the bar a backdrop root. */
		isolation: isolate;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-lg);
		pointer-events: auto;
	}

	/* Translucent + frosted backdrop (theme tokens; opaque under reduced
	   transparency). On a pseudo-element, not the bar itself: an element with
	   `backdrop-filter` is a backdrop root, so the tooltips inside it could
	   only blur the bar's own (empty) contents, never the page (#423). */
	.launcher__bar::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		background: var(--banto-shell-launcher-bg);
		backdrop-filter: var(--banto-shell-launcher-backdrop);
		-webkit-backdrop-filter: var(--banto-shell-launcher-backdrop);
		pointer-events: none;
	}

	.launcher__group {
		display: flex;
	}

	.launcher__list {
		display: flex;
		align-items: flex-end;
		gap: var(--banto-shell-launcher-gap);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.launcher__separator {
		align-self: stretch;
		width: 1px;
		margin-block: var(--banto-shell-launcher-padding);
		background: var(--banto-border);
	}

	.launcher__item {
		position: relative;
		flex: none;
		/* Size, not transform (plan §4.2): neighbours move aside, the bar grows. */
		width: calc(var(--banto-shell-launcher-item-size) * var(--_scale, 1));
		height: calc(var(--banto-shell-launcher-item-size) * var(--_scale, 1));
		transition:
			width var(--banto-duration-base) var(--banto-ease-out),
			height var(--banto-duration-base) var(--banto-ease-out);
	}

	.launcher--magnifying .launcher__item {
		transition-duration: var(--banto-duration-fast);
	}

	.launcher__link {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		border-radius: var(--banto-radius-md);
		color: var(--banto-text-muted);
		text-decoration: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.launcher__link:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.launcher__link:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* Active (plan §4.3): the sidebar's tint and text colour (the darker
	   --banto-primary-hover clears 4.5:1 on the tint), plus a dot under the
	   icon in --banto-primary (3:1 non-text contrast). */
	.launcher__link--active {
		background: color-mix(in srgb, var(--banto-primary) 14%, transparent);
		color: var(--banto-primary-hover);
	}

	.launcher__link--active::after {
		content: '';
		position: absolute;
		bottom: 2px;
		left: 50%;
		width: 4px;
		height: 4px;
		margin-left: -2px;
		border-radius: 50%;
		background: var(--banto-primary);
	}

	/* Glass preset accent (spec M12), as on the sidebar's active item. */
	:global([data-banto-preset='glass']) .launcher__link--active {
		background: var(--banto-accent-gradient);
		color: var(--banto-text-inverse);
	}

	:global([data-banto-preset='glass']) .launcher__link--active::after {
		background: var(--banto-text-inverse);
	}

	.launcher__icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
	}

	/* The icon follows the magnified item (the `size` prop is only a default). */
	.launcher__icon :global(svg) {
		width: 55%;
		height: 55%;
	}

	.launcher__caption {
		display: none;
	}

	.launcher__badge {
		position: absolute;
		top: 0;
		right: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-size: 0.7rem;
		font-weight: 700;
		line-height: 1;
	}

	.launcher__name {
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

	/* Tooltip (plan §4.4). Hoverable (WCAG 1.4.13): it takes the pointer, and
	   the <li>'s ::before bridges the gap above the item, so moving from the
	   icon onto the text keeps the <li> hovered. */
	.launcher__tooltip {
		position: absolute;
		bottom: calc(100% + var(--banto-shell-launcher-padding) + var(--banto-shell-launcher-gap));
		left: 50%;
		translate: -50% 0;
		padding: 0.25rem 0.5rem;
		background: var(--banto-shell-launcher-tooltip-bg);
		backdrop-filter: var(--banto-shell-launcher-tooltip-backdrop);
		-webkit-backdrop-filter: var(--banto-shell-launcher-tooltip-backdrop);
		color: var(--banto-text);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-md);
		font-size: 0.8rem;
		white-space: nowrap;
		pointer-events: auto;
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--banto-duration-fast) var(--banto-ease-out),
			visibility var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Edge items (see `firstId` / `lastId`): grow the tooltip inwards so the
	   scrolling track does not clip it. */
	.launcher__item--first .launcher__tooltip {
		left: 0;
		translate: 0 0;
	}

	.launcher__item--last .launcher__tooltip {
		left: auto;
		right: 0;
		translate: 0 0;
	}

	.launcher__item::before {
		content: '';
		position: absolute;
		inset-inline: 0;
		bottom: 100%;
		height: calc(var(--banto-shell-launcher-padding) + var(--banto-shell-launcher-gap));
		display: none;
	}

	/* The show rules skip a quiet item (Esc hid it: hidden until the pointer
	   leaves / focus moves) instead of a later hide rule fighting them on
	   specificity - `:focus-visible ~` outranked it, so a keyboard-shown
	   tooltip stayed after Esc (#423 review). */
	@media (hover: hover) {
		.launcher__item:not(.launcher__item--quiet):hover .launcher__tooltip {
			opacity: 1;
			visibility: visible;
		}

		.launcher__item:not(.launcher__item--quiet):hover::before {
			display: block;
		}
	}

	.launcher__item:not(.launcher__item--quiet) .launcher__link:focus-visible ~ .launcher__tooltip {
		opacity: 1;
		visibility: visible;
	}

	/* Top (plan §4.1, D4): the bottom bar mirrored - centred below the top
	   edge, under the shell's header (the inset token; the header stays the
	   top row, and its menus are top-layer popovers above the bar). Items
	   grow downwards, the tooltips and their hover bridge sit below the
	   items, the active dot on the screen-edge side. The track scrolls
	   sideways as on the bottom bar, so the edge items' inward tooltips stay.
	   Above 900px only - at <=900px every position is the bottom tab bar
	   (D5), so none of these rules may leak into it. */
	@media not all and (max-width: 900px) {
		.launcher--top {
			inset-inline: 0;
			top: var(--banto-shell-launcher-inset-top);
		}

		.launcher--top .launcher__track {
			padding: var(--banto-shell-launcher-offset) var(--banto-shell-launcher-offset) 2.5rem;
		}

		.launcher--top .launcher__bar,
		.launcher--top .launcher__list {
			align-items: flex-start;
		}

		.launcher--top .launcher__link--active::after {
			top: 2px;
			bottom: auto;
		}

		.launcher--top .launcher__item .launcher__tooltip {
			top: calc(100% + var(--banto-shell-launcher-padding) + var(--banto-shell-launcher-gap));
			bottom: auto;
		}

		.launcher--top .launcher__item::before {
			top: 100%;
			bottom: auto;
		}
	}

	/* Left / right (plan §4.1, D4): a vertical bar centred on that edge.
	   Above 900px only - at <=900px the tab bar below wins over the setting
	   (D5), so none of these rules may leak into it. */
	@media not all and (max-width: 900px) {
		.launcher--vertical {
			inset-block: 0;
			flex-direction: column;
			justify-content: center;
		}

		.launcher--left {
			left: 0;
			align-items: flex-start;
		}

		.launcher--right {
			right: 0;
			align-items: flex-end;
		}

		/* Many items scroll vertically. The scroll box clips on both axes,
		   so the page side keeps the room of the sideways tooltip (its max
		   width + the gap; the bottom bar's 2.5rem top padding is the same
		   idea), the ends along the edge keep 2.5rem for the bar's shadow
		   (a sharp cut line otherwise), and the screen side the offset. */
		.launcher--vertical .launcher__track {
			max-width: none;
			max-height: 100%;
			overflow-x: hidden;
			overflow-y: auto;
		}

		.launcher--left .launcher__track {
			padding: 2.5rem calc(var(--banto-shell-launcher-tooltip-max-width) + 1rem) 2.5rem
				var(--banto-shell-launcher-offset);
		}

		.launcher--right .launcher__track {
			padding: 2.5rem var(--banto-shell-launcher-offset) 2.5rem
				calc(var(--banto-shell-launcher-tooltip-max-width) + 1rem);
		}

		.launcher--vertical .launcher__bar,
		.launcher--vertical .launcher__group,
		.launcher--vertical .launcher__list {
			flex-direction: column;
		}

		/* Items grow towards the page (§4.2): a left bar to the right, a
		   right bar to the left (the bottom bar's flex-end grows upwards). */
		.launcher--left .launcher__bar,
		.launcher--left .launcher__list {
			align-items: flex-start;
		}

		.launcher--right .launcher__bar,
		.launcher--right .launcher__list {
			align-items: flex-end;
		}

		/* The rule between groups lies across the bar (§4.5). */
		.launcher--vertical .launcher__separator {
			width: auto;
			height: 1px;
			margin-block: 0;
			margin-inline: var(--banto-shell-launcher-padding);
		}

		/* Active dot on the icon's outer side, towards the screen edge (§4.3). */
		.launcher--vertical .launcher__link--active::after {
			top: 50%;
			bottom: auto;
			margin: -2px 0 0;
		}

		.launcher--left .launcher__link--active::after {
			left: 2px;
		}

		.launcher--right .launcher__link--active::after {
			left: auto;
			right: 2px;
		}

		/* Tooltip beside the item on the page side, vertically centred. It
		   is shorter than the item, so it never reaches past the item along
		   the scrolling axis and the edge items need no inward alignment
		   (this selector outranks the --first / --last rules). A long label
		   wraps at the token width the track keeps free. */
		.launcher--vertical .launcher__item .launcher__tooltip {
			top: 50%;
			bottom: auto;
			translate: 0 -50%;
			width: max-content;
			max-width: var(--banto-shell-launcher-tooltip-max-width);
			white-space: normal;
		}

		.launcher--left .launcher__item .launcher__tooltip {
			left: calc(100% + var(--banto-shell-launcher-padding) + var(--banto-shell-launcher-gap));
			right: auto;
		}

		.launcher--right .launcher__item .launcher__tooltip {
			left: auto;
			right: calc(100% + var(--banto-shell-launcher-padding) + var(--banto-shell-launcher-gap));
		}

		/* The hover bridge spans the horizontal gap to the tooltip. */
		.launcher--vertical .launcher__item::before {
			inset: 0 auto;
			width: calc(var(--banto-shell-launcher-padding) + var(--banto-shell-launcher-gap));
			height: auto;
		}

		.launcher--left .launcher__item::before {
			left: 100%;
		}

		.launcher--right .launcher__item::before {
			right: 100%;
		}
	}

	/* <=900px (plan §4.6, D5): a full-width bottom tab bar. No magnification
	   (JS skips it too), visible captions, 44px minimum targets, the home
	   indicator inset, sideways scrolling when the items do not fit. */
	@media (max-width: 900px) {
		/* Every position, not only --bottom (D5). */
		.launcher {
			inset-inline: 0;
			bottom: 0;
		}

		.launcher__track {
			width: 100%;
			padding: 0;
			pointer-events: auto;
		}

		.launcher__bar {
			width: auto;
			min-width: max-content;
			align-items: stretch;
			padding: 0 0 env(safe-area-inset-bottom);
			border: none;
			border-top: 1px solid var(--banto-border);
			border-radius: 0;
			box-shadow: none;
		}

		.launcher__group,
		.launcher__list {
			flex: 1 0 auto;
			align-items: stretch;
		}

		.launcher__list {
			gap: 0;
		}

		.launcher__item {
			flex: 1 0 auto;
			width: auto;
			height: auto;
			min-width: var(--banto-shell-launcher-item-size);
			min-height: var(--banto-shell-launcher-item-size);
		}

		.launcher__link {
			flex-direction: column;
			gap: 0.15rem;
			padding: 0.25rem 0.5rem;
			border-radius: 0;
		}

		.launcher__icon {
			width: auto;
			height: auto;
		}

		.launcher__icon :global(svg) {
			width: 1.25rem;
			height: 1.25rem;
		}

		.launcher__caption {
			display: block;
			max-width: 6rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 0.7rem;
		}

		.launcher__badge {
			top: 0.15rem;
			right: auto;
			left: calc(50% + 0.4rem);
		}

		.launcher__link--active::after {
			bottom: 0;
		}

		.launcher__tooltip,
		.launcher__item::before {
			display: none;
		}
	}
</style>
