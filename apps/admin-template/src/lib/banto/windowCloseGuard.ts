/**
 * Desktop window close vs. unsaved changes (issue #214). Closing the Tauri
 * window is an OS window event, not a router navigation, so the
 * unsaved-changes guard (`#lib/unsavedChanges.ts`, built on SvelteKit's
 * `beforeNavigate`) is not relied on for it. This listens to Tauri's
 * close-requested event and asks with the same `window.confirm` the rest of
 * the app uses.
 *
 * Kept in the provider layer (conventions §10): the caller only decides
 * WHEN to watch; the Tauri branch lives here.
 *
 * Blast radius: while a JS close-requested listener exists, Tauri stops the
 * native close and `onCloseRequested` closes the window itself with
 * `destroy()` (capability `core:window:allow-destroy`). The caller therefore
 * registers this only while something is unsaved (`hasUnsavedChanges()`), so
 * a clean app closes exactly as before and any failure here can only affect
 * a window that has unsaved edits.
 */
import { isTauri } from './setup';

/**
 * Start watching the current window's close request. `isPending` is read
 * again when the request arrives (the edit may have been saved meanwhile).
 * Returns a cleanup that stops watching; safe to call before the listener
 * finished registering.
 */
export function guardWindowClose(isPending: () => boolean, message: () => string): () => void {
	if (!isTauri()) return () => {};
	let stopped = false;
	let unlisten: (() => void) | null = null;

	void (async () => {
		try {
			// Dynamic import keeps this module loadable in plain-browser
			// modes (same reason as Header.svelte's fullscreen toggle).
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			const off = await getCurrentWindow().onCloseRequested((event) => {
				if (isPending() && !window.confirm(message())) event.preventDefault();
			});
			if (stopped) off();
			else unlisten = off;
		} catch {
			// No window API/permission: the close proceeds natively, as before.
		}
	})();

	return () => {
		stopped = true;
		unlisten?.();
		unlisten = null;
	};
}
