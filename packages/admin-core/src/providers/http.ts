/**
 * `HttpDataProvider`/`HttpAuthProvider` (spec §3.2, §3.3, §11.1): map
 * `DataProvider`/`AuthProvider` calls onto `fetch()` against
 * `admin-template-core::rest`'s route table, so a LAN browser client talks
 * to the exact same service layer/DB the Tauri webview does.
 *
 * Route table (`apps/admin-template/core/src/rest.rs`'s doc comment is the
 * source of truth):
 * - `getList`   -> `POST {base}/api/{resource}/list` with `ListParams` body
 * - `getOne`    -> `GET {base}/api/{resource}/{id}`
 * - `create`    -> `POST {base}/api/{resource}` with the values body
 * - `update`    -> `PUT {base}/api/{resource}/{id}` with the values body
 * - `deleteOne` -> `DELETE {base}/api/{resource}/{id}`, expects `204`
 *
 * Every request carries `X-Banto-Client: banto` (spec §11.2's CSRF
 * mitigation, `banto_server::csrf`) and, once logged in,
 * `Authorization: Bearer <token>`. No dependency on `@tauri-apps/api` or any
 * particular fetch global - both are injectable so this module (and its
 * tests) run with a mocked `fetchFn` and no real network.
 */
import type {
	AuthOperationResult,
	AuthProvider,
	CredentialRevision,
	DataProvider,
	Identity,
	ResolvedAuth
} from '../provider';
import type { ListParams, ListResult } from '../types';
import { ProviderError, StaleAnswerError, type ErrorBody } from '../errors';

const CLIENT_HEADER_NAME = 'X-Banto-Client';
const CLIENT_HEADER_VALUE = 'banto';
const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Type guard: does `value` look like a wire `ErrorBody` (spec §10/§11.1)? */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

/** Parse a non-2xx `Response` into a `ProviderError`; an unparseable body maps to `kind: 'other'` with the HTTP status line. */
async function errorFromResponse(response: Response): Promise<ProviderError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}
	if (isErrorBody(body)) return new ProviderError(body);
	return new ProviderError({ kind: 'other', message: `${response.status} ${response.statusText}` });
}

function networkError(): ProviderError {
	return new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
}

/**
 * `POST /api/auth/setup`/`/api/auth/change-password` respond `422` with
 * `{kind:'validation',field_errors}` for bad input (spec §8.2, same
 * convention as `items_create`'s validation errors). `setup`/
 * `changePassword` below surface the FIRST field error's message as a plain
 * `{success:false,error}` result instead of throwing, matching
 * `createTauriAuthProvider`'s equivalent mapping.
 */
function firstValidationMessage(err: ProviderError): string {
	if (err.body.kind === 'validation' && err.body.field_errors.length > 0) {
		return err.body.field_errors[0].message;
	}
	return err.message;
}

function headersFor(token: string | null, hasBody: boolean): Record<string, string> {
	const headers: Record<string, string> = { [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE };
	if (hasBody) headers['Content-Type'] = 'application/json';
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

export interface HttpDataProviderOptions {
	/** Prefixed to every request path, e.g. `http://192.168.1.5:8721`. Defaults to `''` (same-origin). */
	baseUrl?: string;
	/** Shares the bearer token with whichever `AuthProvider` logged in (typically `createHttpAuthProvider`'s `getToken`). */
	getToken: () => string | null;
	fetchFn?: typeof fetch;
}

interface RequestInit {
	method: string;
	body?: unknown;
	/** `deleteOne` expects `204 No Content`: skip `response.json()` and resolve `undefined`. */
	expectNoContent?: boolean;
}

/** `DataProvider` backed by `fetch()` against the embedded REST server (spec §11.1). */
export function createHttpDataProvider(options: HttpDataProviderOptions): DataProvider {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;

	async function request<T>(path: string, init: RequestInit): Promise<T> {
		const hasBody = init.body !== undefined;
		let response: Response;
		try {
			response = await fetchFn(`${baseUrl}${path}`, {
				method: init.method,
				headers: headersFor(options.getToken(), hasBody),
				body: hasBody ? JSON.stringify(init.body) : undefined
			});
		} catch {
			throw networkError();
		}
		if (!response.ok) throw await errorFromResponse(response);
		if (init.expectNoContent) return undefined as T;
		return (await response.json()) as T;
	}

	return {
		getList<T>(resource: string, params: ListParams): Promise<ListResult<T>> {
			return request<ListResult<T>>(`/api/${resource}/list`, { method: 'POST', body: params });
		},

		getOne<T>(resource: string, id: string | number): Promise<T> {
			return request<T>(`/api/${resource}/${id}`, { method: 'GET' });
		},

		create<T>(resource: string, values: Record<string, unknown>): Promise<T> {
			return request<T>(`/api/${resource}`, { method: 'POST', body: values });
		},

		update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T> {
			return request<T>(`/api/${resource}/${id}`, { method: 'PUT', body: values });
		},

		deleteOne(resource: string, id: string | number): Promise<void> {
			return request<void>(`/api/${resource}/${id}`, { method: 'DELETE', expectNoContent: true });
		}
	};
}

export interface HttpAuthProviderOptions {
	baseUrl?: string;
	fetchFn?: typeof fetch;
	/** sessionStorage key the bearer token is kept under. Default `'banto.auth.token'`. */
	storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'banto.auth.token';

/** `LoginResult.error` when a login/setup was superseded (Issue #260). */
const SUPERSEDED_MESSAGE = '別のセッションが先に確定したため、このログインは適用されませんでした';

/** Does `value` look like a wire `Identity` (`GET /api/auth/identity`'s 200 body)? */
function isIdentity(value: unknown): value is Identity {
	if (typeof value !== 'object' || value === null) return false;
	const { id, name } = value as { id?: unknown; name?: unknown };
	return typeof id === 'string' && typeof name === 'string';
}

/**
 * `AuthProvider` backed by `fetch()` against `/api/auth/*` (spec §11.1/
 * §11.2/M11). The bearer token returned by a successful login is normally
 * kept in `sessionStorage` (cleared on logout, and when `resolve()` confirms
 * the session invalid - a `401` or a `200 null`, Issue #241 - so a
 * stale/revoked token does not linger in storage). When
 * `login()`'s `params.remember` is `true` (spec M11 "LAN Remember me"), the
 * token is kept in `localStorage` instead, so it survives a browser/tab
 * restart - `getToken()` checks `localStorage` first, then falls back to
 * `sessionStorage`, and `setToken()` always clears whichever storage it did
 * NOT just write to, so a token never ends up duplicated in both at once.
 * The returned object exposes `getToken()` beyond the plain `AuthProvider`
 * interface so `createHttpDataProvider`/`createSseEventProvider` can share
 * the same token without a second source of truth.
 *
 * Issue #260 (docs/design/session-controller-design.md §5.2): the provider keeps a
 * `credentialRevision()` - an in-memory counter that advances on every
 * change it makes to the stored token and on every cross-tab `storage`
 * event for `storageKey` - and:
 * - `resolve()` answers the session with ONE `GET /api/auth/identity`;
 * - every token write is compare-and-set against the revision the
 *   operation started from (`login`/`setup`/`logout`, and
 *   `enterGrant`'s `expectRevision`, #259) AND the stored token read
 *   when it started (PR #264 review P2: another tab's write is visible in
 *   `localStorage` before its `storage` event advances the revision here) -
 *   an operation overtaken by another login/logout (here or in another tab)
 *   writes nothing;
 * - `onCredentialChanged` listeners hear every revision change except
 *   `resolve()`'s own clearing, which its answer carries instead.
 */
export function createHttpAuthProvider(
	options: HttpAuthProviderOptions = {}
): AuthProvider & { getToken(): string | null } {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;
	const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;

	/** The revision counter (I-23): `${counter}.0` is the opaque value handed out. */
	let counter = 0;
	const listeners = new Set<() => void>();

	function revisionOf(value: number): CredentialRevision {
		return `${value}.0` as CredentialRevision;
	}

	function emitCredentialChanged(): void {
		for (const listener of [...listeners]) listener();
	}

	// Another tab changed the shared (Remember me) token (#257): only events
	// for this provider's key count - `key === null` is `localStorage.clear()`,
	// which removes it too. Not reported for this tab's own writes (browsers
	// fire `storage` only in OTHER documents).
	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('storage', (event) => {
			const key = (event as { key?: string | null }).key;
			if (key !== storageKey && key !== null) return;
			counter += 1;
			emitCredentialChanged();
		});
	}

	function getToken(): string | null {
		return localStorage.getItem(storageKey) ?? sessionStorage.getItem(storageKey);
	}

	/** `remember` picks the storage a non-null `token` is written to; a `null` token clears BOTH storages regardless of `remember` (logout/expiry must never leave a stale copy behind in the other one). */
	function setToken(token: string | null, remember = false): void {
		if (token) {
			if (remember) {
				localStorage.setItem(storageKey, token);
				sessionStorage.removeItem(storageKey);
			} else {
				sessionStorage.setItem(storageKey, token);
				localStorage.removeItem(storageKey);
			}
		} else {
			localStorage.removeItem(storageKey);
			sessionStorage.removeItem(storageKey);
		}
	}

	/**
	 * `setToken` and advance the revision if the stored token actually
	 * changed. Returns whether it did. Callers decide whether to notify.
	 */
	function writeToken(token: string | null, remember = false): boolean {
		const before = getToken();
		setToken(token, remember);
		if (getToken() === before) return false;
		counter += 1;
		return true;
	}

	/** What a token-writing operation compares against when it writes. */
	interface OperationStart {
		revision: CredentialRevision;
		/** `getToken()` when the operation started. */
		token: string | null;
	}

	/**
	 * Record an operation's start: the revision (or the caller's
	 * `expectRevision`) and the stored token, both read NOW.
	 */
	function startOperation(expectRevision?: CredentialRevision): OperationStart {
		return { revision: expectRevision ?? revisionOf(counter), token: getToken() };
	}

	/**
	 * Compare-and-set write (Issue #260, I-7): store `token` only while the
	 * revision is still the start's AND the stored token is still the one
	 * read at the start, and notify when the stored token changed. Returns
	 * whether both matched.
	 *
	 * The token condition (PR #264 review P2) closes the window in which
	 * another tab already rewrote the shared `localStorage` token but its
	 * `storage` event (which is what advances the revision here) has not
	 * been delivered yet: the revision alone would still match and this
	 * stale operation would overwrite - or, for a logout, delete - the other
	 * tab's token.
	 */
	function writeTokenIfUnchanged(
		start: OperationStart,
		token: string | null,
		remember = false
	): boolean {
		if (revisionOf(counter) !== start.revision) return false;
		if (getToken() !== start.token) return false;
		if (writeToken(token, remember)) emitCredentialChanged();
		return true;
	}

	function headers(hasBody: boolean): Record<string, string> {
		return headersFor(getToken(), hasBody);
	}

	/**
	 * Clear the stored token only if it is still `token` (compare-and-clear).
	 * A confirmation that arrives after the user logged in again must not wipe
	 * the NEW token - the answer is about the token that was checked. Returns
	 * whether it cleared (the revision then advanced).
	 */
	function clearTokenIfCurrent(token: string): boolean {
		if (getToken() !== token) return false;
		return writeToken(null);
	}

	return {
		async login(params: Record<string, unknown>): Promise<AuthOperationResult> {
			const start = startOperation();
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/login`, {
					method: 'POST',
					headers: headers(true),
					body: JSON.stringify(params)
				});
			} catch {
				return { success: false, error: NETWORK_ERROR_MESSAGE };
			}
			if (!response.ok) {
				const err = await errorFromResponse(response);
				return { success: false, error: err.message };
			}
			const body = (await response.json()) as { success: boolean; error?: string; token?: string };
			if (body.success && body.token) {
				// Issue #260 (S-40): a login/logout that finished while this one
				// was in flight (here or in another tab) wins - do not overwrite.
				if (!writeTokenIfUnchanged(start, body.token, params.remember === true)) {
					return { success: false, error: SUPERSEDED_MESSAGE, superseded: true };
				}
			}
			return { success: body.success, error: body.error };
		},

		/**
		 * `POST /api/auth/logout` with the token held when the logout started
		 * (Issue #260), then clear the stored token - even when the request
		 * failed, since the goal is "this client no longer considers itself
		 * logged in" - but only if no other login/logout changed it meanwhile
		 * (S-21: a login that finished during the logout keeps its token -
		 * including another tab's whose `storage` event has not arrived yet).
		 */
		async logout(): Promise<void> {
			const start = startOperation();
			try {
				await fetchFn(`${baseUrl}/api/auth/logout`, {
					method: 'POST',
					headers: headersFor(start.token, false)
				});
			} catch {
				// Network failure on logout still clears the local token below.
			}
			writeTokenIfUnchanged(start, null);
		},

		/**
		 * Issue #260 (design §2.1, decision 3): ONE `GET /api/auth/identity`
		 * for the token held on entry. `200` with an identity -> `active`;
		 * `200 null` (no token, or a revoked one - a role change included) or
		 * `401` -> `none`, clearing THAT token if it is still stored
		 * (compare-and-set; carried in `current`, not notified); anything else
		 * (a `500`, unreachable, a malformed body) rejects with a
		 * `ProviderError` and changes nothing.
		 */
		async resolve(resolveOptions?: { signal?: AbortSignal }): Promise<ResolvedAuth> {
			const checked = revisionOf(counter);
			const token = getToken();
			if (!token) return { status: 'none', checked, current: checked };
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/identity`, {
					method: 'GET',
					headers: headersFor(token, false),
					signal: resolveOptions?.signal
				});
			} catch {
				throw networkError();
			}
			// Freshness audit of #266 (P3-3, S-105): another tab may have
			// replaced the shared token while this request was in flight, its
			// `storage` event not delivered yet (so the revision has not moved).
			// The answer is about the OLD token: not an answer about what is
			// stored now - reject it as stale (the Tauri `stale` twin; the
			// controller asks again without touching `verification`).
			if (getToken() !== token) throw new StaleAnswerError();
			const none = (): ResolvedAuth => ({
				status: 'none',
				checked,
				current: clearTokenIfCurrent(token) ? revisionOf(counter) : checked
			});
			if (response.status === 401) return none();
			if (!response.ok) throw await errorFromResponse(response);
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			if (body === null) return none();
			if (!isIdentity(body)) {
				throw new ProviderError({
					kind: 'other',
					message: `${response.status} ${response.statusText}`
				});
			}
			return { status: 'active', checked, current: checked, identity: body };
		},

		credentialRevision(): CredentialRevision {
			return revisionOf(counter);
		},

		onCredentialChanged(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		async status(): Promise<{ initialized: boolean; grants: Record<string, boolean> }> {
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/status`, {
					method: 'GET',
					headers: headers(false)
				});
			} catch {
				// No server reachable: treat as "already initialized" so the
				// caller falls back to the normal login form (which will then
				// fail with a clear network error) rather than the setup form.
				// No grants - an unreachable server cannot issue one either.
				return { initialized: true, grants: {} };
			}
			if (!response.ok) return { initialized: true, grants: {} };
			const body = (await response.json()) as {
				initialized: boolean;
				grants?: Record<string, boolean>;
			};
			// A response without `grants` (ADR-0017) means no kind is available:
			// `{}` here so every caller reads `status().grants[kind] === true`
			// without re-deriving the "absent means off" rule itself.
			return { initialized: body.initialized, grants: body.grants ?? {} };
		},

		async setup(params: Record<string, unknown>): Promise<AuthOperationResult> {
			const start = startOperation();
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/setup`, {
					method: 'POST',
					headers: headers(true),
					body: JSON.stringify(params)
				});
			} catch {
				return { success: false, error: NETWORK_ERROR_MESSAGE };
			}
			if (!response.ok) {
				const err = await errorFromResponse(response);
				return { success: false, error: firstValidationMessage(err) };
			}
			const body = (await response.json()) as { success: boolean; error?: string; token?: string };
			if (body.success && body.token) {
				if (!writeTokenIfUnchanged(start, body.token)) {
					return { success: false, error: SUPERSEDED_MESSAGE, superseded: true };
				}
			}
			return { success: body.success, error: body.error };
		},

		async changePassword(
			current: string,
			next: string
		): Promise<{ success: boolean; error?: string }> {
			const token = getToken();
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/change-password`, {
					method: 'POST',
					headers: headersFor(token, true),
					body: JSON.stringify({ currentPassword: current, newPassword: next })
				});
			} catch {
				return { success: false, error: NETWORK_ERROR_MESSAGE };
			}
			// Freshness audit of #266 (P3-4, S-106): a `401` means the session
			// this change was sent with is no longer valid - clear THAT token
			// (compare-and-set) and report it, as the Tauri provider does for an
			// `unauthorized` `change_own_password`.
			if (response.status === 401 && token !== null && clearTokenIfCurrent(token)) {
				emitCredentialChanged();
			}
			if (!response.ok) {
				const err = await errorFromResponse(response);
				return { success: false, error: firstValidationMessage(err) };
			}
			return { success: true };
		},

		/**
		 * `POST /api/auth/grant/{kind}` (ADR-0017; viewer-public is
		 * `kind: 'publicViewer'`, viewer-public-plan §2.1/§3.1-2, ADR-0012): no
		 * request body, no bearer token required - the CSRF `X-Banto-Client`
		 * header is still added (every request needs it) but never
		 * `Authorization`, since `getToken()` is null before this call
		 * succeeds. On success the returned token is stored the same way a
		 * normal login's is (`setToken`, `remember: false` - sessionStorage
		 * only, viewer-public-plan §3.1-6 "Remember me は適用しない"). Never
		 * throws: a 404 (unregistered kind), a 403 (the kind's condition does
		 * not hold) or a network failure all resolve `{ success: false }` so
		 * the route guard keeps its confirmed `none`.
		 *
		 * Issue #260 (#259, S-20/S-52): stored only while the revision is still
		 * `expectRevision` (default: the revision when this call started) AND
		 * no token is stored - checked both when this call starts and right
		 * before the write, with or without `expectRevision` (PR #264 review
		 * P2 / re-review P1). A grant is only ever requested for "no
		 * credential at all": a token already present at the start - e.g.
		 * another tab's, written after the caller's `resolve()`/ticket but
		 * before its `storage` event advanced the revision here - means
		 * `{ success: false, superseded: true }` without a request, and so does
		 * one that appears while the request is in flight. The caller then
		 * confirms that token (`grantFallback` runs `resolveSettled()`, whose
		 * `resolve()` clears a revoked one, within its bounded retry loop).
		 */
		async enterGrant(
			kind: string,
			grantOptions?: { expectRevision?: CredentialRevision }
		): Promise<{ success: boolean; superseded?: boolean }> {
			const start = startOperation(grantOptions?.expectRevision);
			if (start.token !== null) return { success: false, superseded: true };
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/grant/${encodeURIComponent(kind)}`, {
					method: 'POST',
					headers: headersFor(null, false)
				});
			} catch {
				return { success: false };
			}
			if (!response.ok) return { success: false };
			const body = (await response.json()) as { success: boolean; token?: string };
			if (!body.success || !body.token) return { success: false };
			// `start.token` is null here: the write needs the revision to match
			// AND `getToken() === null`.
			if (!writeTokenIfUnchanged(start, body.token, false)) {
				return { success: false, superseded: true };
			}
			return { success: true };
		},

		getToken
	};
}
