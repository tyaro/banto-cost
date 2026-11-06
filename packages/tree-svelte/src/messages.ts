/**
 * i18n message bundle for the tree components (layer 1). Packages carry no
 * app-specific strings: every message is a FUNCTION (parameterised ones take
 * args, static ones take none) with a Japanese default, and the app overrides
 * them with resolved (e.g. Paraglide) strings via the `messages` prop —
 * `const t = { ...defaultTreeMessages, ...messages }`.
 */
export interface TreeMessages {
	/** Aria-label for the expand toggle of a collapsed node. */
	expand?: (label: string) => string;
	/** Aria-label for the collapse toggle of an expanded node. */
	collapse?: (label: string) => string;
	/** Aria-label for a node's checkbox. */
	checkbox?: (label: string) => string;
	/** Shown next to a lazy branch while its children are loading. */
	loading?: () => string;
	/** Shown next to a lazy branch whose child load failed. */
	loadError?: () => string;
	/** Shown when the tree has no nodes. */
	empty?: () => string;
	/** Aria-label for the inline rename input. */
	rename?: (label: string) => string;
	/** Header of the implicit first (tree) column in tree-grid mode. */
	nameColumn?: () => string;
}

export const defaultTreeMessages: Required<TreeMessages> = {
	expand: (label) => `${label} を展開`,
	collapse: (label) => `${label} を折りたたむ`,
	checkbox: (label) => `${label} を選択`,
	loading: () => '読み込み中…',
	loadError: () => '読み込みに失敗しました',
	empty: () => '項目がありません',
	rename: (label) => `${label} の名前を変更`,
	nameColumn: () => '名前'
};
