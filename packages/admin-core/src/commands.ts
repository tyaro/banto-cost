/**
 * Command palette registry (spec M16): a headless, pure search over a flat
 * list of `PaletteCommand`s. This module owns only the type + the fuzzy
 * search - it does NOT know how commands are derived (that's the app's
 * `commands.ts`, built from `navigation.ts` + theme/session actions) and it
 * does NOT touch `localStorage` itself (recency is the caller's concern -
 * `recentIds` is just an ordered array of ids passed in, same "headless core,
 * app owns persistence" split as `providers/uiSettings.ts` vs
 * `settings.svelte.ts`).
 *
 * `PaletteCommand` stays structurally assignable to `@banto/ui`'s
 * `CommandSpec` (the optional `enabled` / `checked` / `shortcut` fields,
 * shared-primitives-upstream-plan §3.6, D2-a), so one command list feeds the
 * palette, menus and the shortcut dispatcher - without either package
 * importing the other (conventions §4 / §5).
 */

export interface PaletteCommand {
	/** Stable, unique across the whole palette (e.g. `nav./items`, `theme.mode.dark`). Also the value persisted into the `recentIds` localStorage list by the caller. */
	id: string;
	title: string;
	/** Section heading in the UI (e.g. 'ナビゲーション' | 'テーマ' | 'セッション'). */
	group: string;
	/** Extra search terms (e.g. an English alias) matched the same way as `title`, but never shown. */
	keywords?: string[];
	/** RBAC/mode gate (e.g. admin-only nav entries, hidden when auth is disabled). Omitted = always visible. */
	visible?: () => boolean;
	/**
	 * Usable now? Omitted = enabled. `searchCommands` ignores it (a disabled
	 * command is still found); the UI shows it disabled and a dispatcher
	 * calls it again right before `run` (shared-primitives-upstream-plan §3.6).
	 */
	enabled?: () => boolean;
	/** Toggle state for menus (display only). */
	checked?: () => boolean;
	/** Shortcut such as `'Mod+K'` (`Mod` = Ctrl, or Meta on macOS) - parsed, matched and shown by `@banto/ui`. */
	shortcut?: string;
	run: () => void | Promise<void>;
}

/** Match strength for one candidate string against the (already trimmed+lowercased) query. Higher = better; 0 = no match. */
function matchScore(candidate: string, query: string): number {
	const lower = candidate.toLowerCase();
	if (lower.startsWith(query)) return 3;
	// 単語頭一致: query matches the start of some whitespace-separated word
	// within the candidate (e.g. "audit" matching "Audit Log" past its space).
	if (lower.split(/\s+/).some((word) => word.startsWith(query))) return 2;
	if (lower.includes(query)) return 1;
	return 0;
}

/** Best match strength across a command's `title` and `keywords` (spec: "title と keywords 両方を対象"). */
function commandScore(command: PaletteCommand, query: string): number {
	let score = matchScore(command.title, query);
	for (const keyword of command.keywords ?? []) {
		const keywordScore = matchScore(keyword, query);
		if (keywordScore > score) score = keywordScore;
	}
	return score;
}

/**
 * Search `commands` for `query`, applying visibility (RBAC etc.) first.
 *
 * - Empty/whitespace-only query: every visible command, `recentIds` entries
 *   first (in the order given), the rest in their original array order.
 * - Non-empty query: prefix match > word-start match > substring match
 *   (case-insensitive; Japanese text matches by plain substring, no
 *   normalization). Commands that don't match anything are excluded. Within
 *   the same score, `recentIds` order wins as a tiebreaker, then original
 *   array order.
 */
export function searchCommands(
	commands: PaletteCommand[],
	query: string,
	recentIds: string[] = []
): PaletteCommand[] {
	const trimmed = query.trim().toLowerCase();

	// First occurrence wins so a (defensively) duplicated id still sorts by
	// its most-recent position.
	const recentIndex = new Map<string, number>();
	for (const [i, id] of recentIds.entries()) {
		if (!recentIndex.has(id)) recentIndex.set(id, i);
	}

	const candidates = commands
		.filter((command) => command.visible?.() ?? true)
		.map((command, index) => ({
			command,
			index,
			score: trimmed === '' ? 0 : commandScore(command, trimmed)
		}))
		.filter((entry) => trimmed === '' || entry.score > 0);

	candidates.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		const aRecent = recentIndex.get(a.command.id);
		const bRecent = recentIndex.get(b.command.id);
		if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent;
		if (aRecent !== undefined) return -1;
		if (bRecent !== undefined) return 1;
		return a.index - b.index;
	});

	return candidates.map((entry) => entry.command);
}
