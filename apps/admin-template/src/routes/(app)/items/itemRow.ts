/**
 * M5 Phase B (spec §4.3) grouping demo: a client-only derived row shape with
 * a `category` field (the item name's first whitespace token, e.g. "緑茶
 * 500ml" -> "緑茶"), so the shared items header's group-by select has a
 * column worth grouping by. `Item` itself (and the server-mode grid) stay
 * untouched - this is purely a client-mode presentation concern.
 *
 * Shared between `ItemsClientGrid.svelte` (which maps every fetched row
 * through `toItemRow` before handing them to `BantoGrid`) and `+page.svelte`
 * (Issue #215/#255 review: the "did this save fall outside the client
 * grid's restored filters?" check must run `filterRows` against the SAME
 * derived shape the grid actually renders/filters - `category` included -
 * or a category filter always reports a false "excluded" for a row that is
 * still on screen, since the raw saved values have no `category` field at
 * all). Previously duplicated inside `ItemsClientGrid.svelte` alone; pulled
 * out here once a second caller needed the exact same derivation.
 */
import type { Item } from '#lib/banto/sampleData.js';

export type ItemRow = Item & { category: string };

/** Derive the grouping demo's `category` field (spec §4.3): name's first whitespace token. */
export function toItemRow(item: Item): ItemRow {
	return { ...item, category: item.name.split(/\s+/)[0] ?? item.name };
}
