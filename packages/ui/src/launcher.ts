/**
 * Types and pure helpers behind LauncherBar - the macOS-dock-like icon
 * launcher (docs/design/nav-launcher-plan.md §4, §5.3;
 * docs/adr/0018-shared-ui-package.md §11, phase 5). Kept out of the component
 * so the magnification curve is unit-testable without a layout engine.
 *
 * The code name is `launcher` everywhere: `dock` already means
 * `@banto/dock-svelte` and the `--banto-dock-*` tokens (plan §2.4, D1).
 */
import type { UiIconComponent } from './types';

/**
 * Where the bar sits (nav-launcher-plan.md §4.1, D4): `'bottom'` (the
 * default) floats centred above the bottom edge; `'top'` floats centred
 * below the top edge, pushed down by `--banto-shell-launcher-inset-top` (the
 * shell sets it to its header's height so the header stays on top);
 * `'left' | 'right'` are a vertical bar centred on that edge. At <=900px
 * every position becomes the full-width bottom tab bar (§4.6, D5).
 */
export type LauncherPosition = 'bottom' | 'top' | 'left' | 'right';

/** One link of the bar. The caller decides routing, `active` and RBAC filtering. */
export interface LauncherItem {
	/** Stable key (unique within the bar). */
	id: string;
	href: string;
	/** Visible name: the tooltip, the narrow-screen caption and the accessible name. */
	label: string;
	icon: UiIconComponent;
	/** The current page - rendered with `aria-current="page"`. */
	active?: boolean;
	/** Count pill: `text` is drawn, `label` (e.g. "3 updates") joins the accessible name. */
	badge?: { text: string; label: string };
}

/** One landmark: rendered as its own `<nav aria-label>`, separated from the next by a rule. */
export interface LauncherGroup {
	id: string;
	ariaLabel: string;
	items: LauncherItem[];
}

/**
 * How far the magnification reaches, in item sizes (plan §4.2: "about 2.5
 * items"). LauncherBar multiplies it by the item-size token.
 */
export const LAUNCHER_MAGNIFY_RANGE_ITEMS = 2.5;

/**
 * Scale of an item whose centre is `distance` px from the pointer along the
 * bar's main axis: `1 + (max - 1) * f(d)`, where `f` falls smoothly (cosine)
 * from 1 at `d = 0` to 0 at `|d| >= range` (plan §4.2). Returns exactly 1 when
 * `max <= 1`, `range <= 0` or any input is not a finite number - never NaN, so
 * an unreadable token degrades to "no magnification".
 */
export function magnifyScale(distance: number, range: number, max: number): number {
	if (!Number.isFinite(distance) || !Number.isFinite(range) || !Number.isFinite(max)) return 1;
	if (max <= 1 || range <= 0) return 1;
	const d = Math.abs(distance);
	if (d >= range) return 1;
	const falloff = (1 + Math.cos((Math.PI * d) / range)) / 2;
	return 1 + (max - 1) * falloff;
}
