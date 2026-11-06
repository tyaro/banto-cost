/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/ui. Same convention as `defaultGridMessages` in
 * @banto/grid-svelte - every message is a function so callers always call
 * `t.key(...)` uniformly; `defaultUiMessages` holds the Japanese literal
 * verbatim, so passing nothing reproduces the stock output.
 *
 * Components with their own text take `messages?: UiMessages` and merge it
 * over the defaults (CommandPalette, ToastHost, Modal, Drawer). Apps that localise (admin-template
 * does, via Paraglide) pass their own text explicitly - see `LoadingState`'s
 * `label` and admin-template's CommandPalette wrapper.
 */

export interface UiMessages {
	/** LoadingState's screen-reader announcement when no `label` is given. */
	loading?: () => string;
	/** CommandPalette: the dialog's accessible name. */
	commandPaletteLabel?: () => string;
	/** CommandPalette: the search input's placeholder. */
	commandPalettePlaceholder?: () => string;
	/** CommandPalette: the result list's accessible name. */
	commandPaletteListLabel?: () => string;
	/** CommandPalette: shown when nothing matches. */
	commandPaletteEmpty?: () => string;
	/** CommandPalette: heading of the recent section (`recentIds`). */
	commandPaletteRecent?: () => string;
	/** ToastHost: the close button's accessible name. */
	toastClose?: () => string;
	/** Modal / Drawer: the close (×) button's accessible name and tooltip. */
	overlayClose?: () => string;
}

export const defaultUiMessages: Required<UiMessages> = {
	loading: () => '読み込み中…',
	commandPaletteLabel: () => 'コマンドパレット',
	commandPalettePlaceholder: () => 'コマンドを検索…',
	commandPaletteListLabel: () => 'コマンド一覧',
	commandPaletteEmpty: () => '一致するコマンドがありません',
	commandPaletteRecent: () => '最近使ったもの',
	toastClose: () => '閉じる',
	overlayClose: () => '閉じる'
};
