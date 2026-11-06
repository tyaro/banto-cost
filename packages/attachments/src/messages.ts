/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/attachments' `AttachmentsPanel.svelte`. Mirrors
 * @banto/grid-svelte's `messages.ts` convention - every message is a function
 * (parameterized ones take the relevant arguments, static ones take none) so
 * callers always call `t.key(...)` uniformly; `defaultAttachmentsMessages`
 * holds the current Japanese literals verbatim, so passing nothing
 * reproduces today's output exactly.
 *
 * NOTE: `AttachmentsPanel`'s `title` prop (default '添付ファイル') is a
 * separate, already-existing prop - it is NOT part of this bundle.
 */

export interface AttachmentsMessages {
	/** Delete confirmation dialog text, given the attachment's file name. */
	deleteConfirm?: (fileName: string) => string;
	/** Upload button label while an upload is in flight. */
	uploading?: () => string;
	/** Upload button label while idle. */
	upload?: () => string;
	/** Hidden file `<input>`'s aria-label, given the panel's `title`. */
	uploadAriaLabel?: (title: string) => string;
	/** Loading status message. */
	loading?: () => string;
	/** Retry button label (shown alongside a load error). */
	retry?: () => string;
	/** Empty-state message when there are zero attachments. */
	empty?: () => string;
	/** Delete button label (thumbnail tile and file-row list). */
	remove?: () => string;
	/** Download button label (file-row list). */
	download?: () => string;
	/** Fallback error message (core/errors.ts's `errorMessage`) when the thrown value has no usable message. */
	unknownError?: () => string;
}

export const defaultAttachmentsMessages: Required<AttachmentsMessages> = {
	deleteConfirm: (fileName) => `「${fileName}」を削除しますか？`,
	uploading: () => 'アップロード中…',
	upload: () => 'アップロード',
	uploadAriaLabel: (title) => `${title}をアップロード`,
	loading: () => '読み込み中…',
	retry: () => '再試行',
	empty: () => '添付ファイルはありません',
	remove: () => '削除',
	download: () => 'ダウンロード',
	unknownError: () => '不明なエラーが発生しました'
};
