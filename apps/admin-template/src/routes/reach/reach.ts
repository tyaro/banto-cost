/**
 * Spec §11.4 (LAN settings UX). The device side of the LAN reach check
 * (Issue #219 stage 1 / PR-C3, lan-reach-check-design §3.2, §3.10, §4.3,
 * D2): the `/reach` page reads the one-time token from the URL fragment
 * (`#t=<token>` - a fragment never reaches a server log, a proxy or a
 * `Referer`), removes it from the address bar and the history entry at
 * once, and sends it with `POST /api/reach-check`.
 *
 * Nothing here logs in or creates a session: the request carries only the
 * CSRF header the server requires of every `/api/*` call and the token, and
 * the answer is a result code the page maps to its own text
 * (conventions §13). It works the same whether viewer-public (#189) is on
 * or off - it never touches the auth provider.
 */
import { CSRF_HEADER } from '#lib/banto/environment.js';

/** `POST /api/reach-check`'s result codes (design §3.10). */
export type ReachResult = 'recorded' | 'selfAccess' | 'unusable' | 'hostMismatch' | 'rateLimited';

const RESULTS: ReadonlySet<string> = new Set([
	'recorded',
	'selfAccess',
	'unusable',
	'hostMismatch',
	'rateLimited'
]);

/** The path of the reach-check route (`banto_server::REACH_CHECK_PATH`). */
export const REACH_CHECK_PATH = '/api/reach-check';

/** A token is a `uuid` v4 in its hyphenated form (`banto_server::reach_check`). */
const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token in a `#t=<token>` fragment, or `null` when there is none or it has another shape. */
export function parseReachToken(hash: string): string | null {
	const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
	if (fragment === '') return null;
	const token = new URLSearchParams(fragment).get('t');
	return token !== null && TOKEN_SHAPE.test(token) ? token : null;
}

/**
 * Reads the token from `location`'s fragment and removes the fragment from
 * the address bar and the current history entry (`replaceState`, keeping
 * the router's state) BEFORE anything is sent - a malformed fragment is
 * removed too. Returns the token, or `null` when there is none to send.
 */
export function takeReachToken(
	location: Pick<Location, 'hash' | 'pathname' | 'search'>,
	history: Pick<History, 'replaceState' | 'state'>
): string | null {
	const hash = location.hash;
	if (hash === '' || hash === '#') return null;
	const token = parseReachToken(hash);
	history.replaceState(history.state, '', `${location.pathname}${location.search}`);
	return token;
}

/**
 * Sends `token` to `POST /api/reach-check` and returns the result code, or
 * `'failed'` when the request did not get through or the answer carried no
 * known code (e.g. the CSRF layer's own `403`, a proxy's error page).
 */
export async function postReachCheck(
	token: string,
	fetchFn: typeof fetch = fetch
): Promise<ReachResult | 'failed'> {
	let response: Response;
	try {
		response = await fetchFn(REACH_CHECK_PATH, {
			method: 'POST',
			headers: { ...CSRF_HEADER, 'Content-Type': 'application/json' },
			body: JSON.stringify({ token }),
			cache: 'no-store',
			credentials: 'omit'
		});
	} catch {
		return 'failed';
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return 'failed';
	}
	const result =
		typeof body === 'object' && body !== null ? (body as { result?: unknown }).result : undefined;
	return typeof result === 'string' && RESULTS.has(result) ? (result as ReachResult) : 'failed';
}
