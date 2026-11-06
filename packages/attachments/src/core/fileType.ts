/**
 * Short type badge for non-thumbnail file rows (attachments-plan §3.7: "非画像は
 * ファイル行（種別アイコン + fileName + サイズ表示）"). No icon library
 * dependency is added for this (forms/charts/grid-svelte don't carry one
 * either) - a short uppercase extension badge fills the same "what kind of
 * file is this at a glance" role.
 */

const MAX_LABEL_LENGTH = 4;
const FALLBACK_LABEL = 'FILE';

/** Derives a short badge label (e.g. `"PDF"`, `"GZ"`) from `fileName`'s extension. */
export function fileTypeLabel(fileName: string): string {
	const dotIndex = fileName.lastIndexOf('.');
	// No extension, a dotfile with nothing before the dot (e.g. ".gitignore"),
	// or a trailing dot with nothing after it: none of these are a usable
	// extension, so fall back rather than badge on garbage.
	if (dotIndex <= 0 || dotIndex === fileName.length - 1) return FALLBACK_LABEL;
	const ext = fileName.slice(dotIndex + 1).toUpperCase();
	return ext.length > MAX_LABEL_LENGTH ? ext.slice(0, MAX_LABEL_LENGTH) : ext;
}
