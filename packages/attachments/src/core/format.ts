/**
 * Human-readable file size formatting (attachments-plan §3.7: "サイズ表示は KB/MB の
 * 人間可読形式"). Pure function, unit-tested directly (no component render
 * needed) per the package's existing testing convention (charts/forms keep
 * logic in `core/*.ts` for exactly this reason).
 */

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Formats `bytes` as e.g. `"512 B"`, `"3.4 KB"`, `"12 MB"`. Values below
 * 100 in the chosen unit keep one decimal place (so small KB/MB values stay
 * legible); 100 and above round to a whole number (a fraction adds no
 * useful precision once the number is that large). Negative/non-finite
 * input (should never happen - `sizeBytes` comes from the server) falls
 * back to `"0 B"` rather than throwing.
 */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	if (bytes < 1024) return `${Math.round(bytes)} B`;

	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < UNITS.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${UNITS[unitIndex]}`;
}
