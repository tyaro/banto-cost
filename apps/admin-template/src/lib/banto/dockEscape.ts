/**
 * The dashboard's `DockHost.isEscapeBlocked` (shared-primitives-upstream-plan
 * §3.3 / §4.3, #433-b): should a dock gesture leave this Esc to a higher layer?
 *
 * `@banto/dock-svelte` may not import `@banto/ui` (conventions §4, plan §2.1),
 * so the app joins the two. Every floating dock window is a NON-modal
 * `role="dialog"`, which `hasVisibleLayerAbove()` without `except` counts as a
 * layer: the gesture's own window - and, for a divider / docked pane gesture,
 * any other open floating window - would then block the Esc and it would never
 * cancel. So:
 *  - a gesture on a floating window (`activeLayer` = its root) yields only to
 *    layers ABOVE that window (`hasVisibleLayerAbove({ except })`);
 *  - a docked pane / divider gesture (`null`) yields only to modal layers and
 *    menus (Modal, Drawer, context menus), not to floating windows.
 */
import { hasVisibleLayerAbove, hasVisibleMenuLayer, hasVisibleModalLayer } from '@banto/ui';

export function isDockEscapeBlocked(activeLayer: HTMLElement | null): boolean {
	return activeLayer
		? hasVisibleLayerAbove({ except: activeLayer })
		: hasVisibleModalLayer() || hasVisibleMenuLayer();
}
