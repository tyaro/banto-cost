/**
 * CommandPalette data model (docs/adr/0018-shared-ui-package.md §8, phase 2b):
 * the item shape, the built-in search and the group clustering. Pure
 * functions - no DOM, no stores - so the component stays a thin view over
 * them and the logic is testable on its own.
 *
 * `CommandPaletteItem` is structurally compatible with `@banto/admin-core`'s
 * `PaletteCommand` (`id`/`title`/`group`/`keywords`), so an app can pass its
 * `PaletteCommand[]` straight in and get the same objects back in
 * `onExecute` - without this package importing admin-core
 * (rule `package-bare-imports`).
 */
import type { UiIconComponent } from './types';

export interface CommandPaletteItem {
	/** Unique within the palette. Also what an app records as "recent". */
	id: string;
	/** Visible label. */
	title: string;
	/** Section heading. Items without a group render under no heading. */
	group?: string;
	/** Extra search terms matched like `title`, never shown. */
	keywords?: readonly string[];
	/** Optional leading icon (lucide components fit as-is). */
	icon?: UiIconComponent;
	/** Shown but not selectable/executable; keyboard navigation skips it. */
	disabled?: boolean;
	/** Optional shortcut hint shown on the right (display only, e.g. `Ctrl+S`). */
	shortcut?: string;
}

/** Why the palette closed (passed to `onClose`). */
export type CommandPaletteCloseReason = 'escape' | 'outside' | 'execute';

/**
 * The built-in search: case-insensitive substring match on `title` and
 * `keywords`, original order kept. An empty / whitespace-only query returns
 * every item. Apps that want scoring or recency ordering pass their own
 * `search` (admin-template passes admin-core's `searchCommands`).
 */
export function defaultCommandPaletteSearch<T extends CommandPaletteItem>(
	query: string,
	items: readonly T[]
): T[] {
	const needle = query.trim().toLowerCase();
	if (needle === '') return [...items];
	return items.filter(
		(item) =>
			item.title.toLowerCase().includes(needle) ||
			(item.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle))
	);
}

export interface CommandPaletteRow<T> {
	item: T;
	/** Position in the flattened, group-clustered order (keyboard numbering). */
	index: number;
}

export interface CommandPaletteGroup<T> {
	/** Unique key for the keyed `{#each}`. */
	key: string;
	/** Heading text; `undefined` renders no heading. */
	heading: string | undefined;
	rows: CommandPaletteRow<T>[];
}

/**
 * Cluster already-ordered results by `group`, keeping each group's
 * first-appearance position, so items of one group stay under one heading
 * instead of interleaving by score. With `recent` (only used for an empty
 * query), those items come first under `recentHeading` and are not repeated
 * in their own group.
 */
export function groupCommandPaletteItems<T extends CommandPaletteItem>(
	results: readonly T[],
	recent: readonly T[] = [],
	recentHeading?: string
): CommandPaletteGroup<T>[] {
	const groups: CommandPaletteGroup<T>[] = [];
	let index = 0;
	const recentIds = new Set(recent.map((item) => item.id));
	if (recent.length > 0) {
		groups.push({
			key: '\u0000recent',
			heading: recentHeading,
			rows: recent.map((item) => ({ item, index: index++ }))
		});
	}
	const order: string[] = [];
	const byGroup = new Map<string, T[]>();
	for (const item of results) {
		if (recentIds.has(item.id)) continue;
		const key = item.group ?? '';
		let bucket = byGroup.get(key);
		if (!bucket) {
			bucket = [];
			byGroup.set(key, bucket);
			order.push(key);
		}
		bucket.push(item);
	}
	for (const key of order) {
		groups.push({
			key: `group:${key}`,
			heading: key === '' ? undefined : key,
			rows: byGroup.get(key)!.map((item) => ({ item, index: index++ }))
		});
	}
	return groups;
}
