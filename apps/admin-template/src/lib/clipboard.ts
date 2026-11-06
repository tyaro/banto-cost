/**
 * Spec §11.4 (LAN settings UX: the Windows Firewall guidance). Copy plain text to the clipboard (Issue #219's firewall information).
 * Same two-step approach as `@banto/grid-svelte`'s range copy:
 * `navigator.clipboard.writeText` first, then a hidden textarea +
 * `execCommand('copy')` for webviews without the async clipboard API or a
 * rejected write. Resolves `true` when one of them reported success.
 */
export async function copyText(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// fall through to the execCommand fallback below
		}
	}
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	textarea.select();
	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}
