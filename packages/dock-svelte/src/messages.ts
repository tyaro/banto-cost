/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/dock-svelte's Svelte components (DockHost, DockedTree,
 * DockWindow). Mirrors @banto/grid-svelte's `messages.ts` convention - every
 * message is a function (parameterized ones take the relevant arguments,
 * static ones take none) so callers always call `t.key(...)` uniformly;
 * `defaultDockMessages` holds the current Japanese literals verbatim, so
 * passing nothing reproduces today's output exactly.
 */

export interface DockMessages {
	/** Pop-out button aria-label (DockedTree panel/tab titlebar, DockWindow titlebar), given the panel/window's title. */
	popOut?: (title: string) => string;
	/** Close button aria-label (DockedTree panel/tab titlebar, DockWindow titlebar), given the panel/window's title. */
	close?: (title: string) => string;
	/** Split divider's aria-label (DockedTree). */
	resizeHandle?: () => string;
	/** Keyboard move-mode button aria-label (DockWindow titlebar), given the window's title. Says how the mode is driven (#433-b, D5). */
	moveWindow?: (title: string) => string;
	/** Keyboard resize-mode button aria-label (DockWindow titlebar), given the window's title. */
	resizeWindow?: (title: string) => string;
}

export const defaultDockMessages: Required<DockMessages> = {
	popOut: (title) => `${title}を別ウィンドウで開く`,
	close: (title) => `${title}を閉じる`,
	resizeHandle: () => 'パネルのサイズ変更',
	moveWindow: (title) =>
		`${title}をキーボードで移動（矢印で動かす・Shift で大きく・Enter で確定・Esc で取消）`,
	resizeWindow: (title) =>
		`${title}をキーボードでサイズ変更（矢印で変える・Shift で大きく・Enter で確定・Esc で取消）`
};
