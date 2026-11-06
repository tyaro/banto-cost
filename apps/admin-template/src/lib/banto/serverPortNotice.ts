/**
 * The toast for the launch-time port fallback of the embedded LAN server:
 * when the saved port was in use, src-tauri started the server on a port
 * right behind it (and saved that port), or could not start it at all, and
 * reports that as `ServerStatus.portNotice` (codes and port numbers only).
 * The text is built here from the messages (conventions §13).
 *
 * Shown once per page load, to admins in the desktop window only: the notice
 * travels in `server_status`, which is admin-only like the rest of the server
 * controls (spec M10), and only an admin can change the port.
 */
import type { NotificationKind } from '@banto/admin-core';
import * as m from '#lib/paraglide/messages.js';
import type { ServerPortNotice, ServerStatus } from './serverAdmin';

/** The toast text for `notice`, in the current locale. */
export function serverPortNoticeMessage(notice: ServerPortNotice): string {
	// Port numbers as plain strings: no locale digit grouping ("8,721").
	const requestedPort = String(notice.requestedPort);
	if (notice.kind === 'exhausted') {
		// Not "all in use" when some candidate failed for another reason
		// (e.g. a port the OS reserves).
		const message = notice.allInUse
			? m['settings.portFallbackExhausted']
			: m['settings.portFallbackNoUsablePort'];
		return message({ requestedPort, lastPort: String(notice.lastPort) });
	}
	const port = String(notice.port);
	return notice.saved
		? m['settings.portFallbackStarted']({ requestedPort, port })
		: m['settings.portFallbackNotSaved']({ requestedPort, port });
}

export interface ServerPortNoticeDeps {
	getStatus: () => Promise<ServerStatus>;
	notify: (kind: NotificationKind, message: string) => void;
}

let shown = false;

/**
 * Read the server status once and toast its `portNotice`, if any. Later
 * calls in the same page load do nothing (the layout remounts on every
 * login). A failed status read is ignored - the settings screen still shows
 * the live state.
 */
export async function notifyServerPortNoticeOnce(deps: ServerPortNoticeDeps): Promise<void> {
	if (shown) return;
	shown = true;
	let notice: ServerPortNotice | null | undefined;
	try {
		notice = (await deps.getStatus()).portNotice;
	} catch {
		return;
	}
	if (!notice) return;
	// Started and saved: for information. Started but not saved: the next
	// launch tries the old port again. Not started: LAN access is down.
	const kind: NotificationKind =
		notice.kind === 'exhausted' ? 'error' : notice.saved ? 'info' : 'warning';
	deps.notify(kind, serverPortNoticeMessage(notice));
}

/** Test seam: forget that the notice was shown. */
export function resetServerPortNoticeForTest(): void {
	shown = false;
}
