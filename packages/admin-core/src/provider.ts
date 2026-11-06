/**
 * DataProvider/AuthProvider/Notifier contracts (spec §3.2, §3.3, §3.4).
 * UI-agnostic: no Svelte imports here.
 */
import type { ListParams, ListResult } from './types';

/** Backend-agnostic CRUD abstraction. Implementations throw `ProviderError`. */
export interface DataProvider {
	getList<T>(resource: string, params: ListParams): Promise<ListResult<T>>;
	getOne<T>(resource: string, id: string | number): Promise<T>;
	create<T>(resource: string, values: Record<string, unknown>): Promise<T>;
	update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T>;
	deleteOne(resource: string, id: string | number): Promise<void>;
}

export interface Identity {
	id: string;
	name: string;
	/**
	 * Spec M10 RBAC: the account's role (`'admin' | 'editor' | 'viewer'`,
	 * lowercase, matching `admin_template_core::users::Role::as_str`/the
	 * Tauri `Identity`/REST `/api/auth/identity` wire shape). Optional here
	 * so this generic contract stays usable by an `AuthProvider` that has no
	 * concept of roles at all — callers that care (this app's
	 * `#lib/permissions.ts`) must treat a missing/unrecognized value as the
	 * least-privileged role (fail closed), not assume it is always present.
	 */
	role?: string;
	/**
	 * The session's kind as the ISSUER reports it (ADR-0017; the REST
	 * `GET /api/auth/identity` body): a grant kind (`'publicViewer'`, an
	 * app's `'commissioning'`, ...) or `'account'`. Never inferred from an
	 * account id or role - a real account can also have the username
	 * `public`. Missing means the issuer does not report it (the Tauri
	 * provider sends the kind on `ResolvedAuth.kind` instead); the
	 * controller then falls back to the provider's kind, then `'account'`
	 * (`kindOfResolvedAuth`).
	 */
	kind?: string;
}

/**
 * Which credential an `AuthProvider` answer is about (Issue #260,
 * docs/design/session-controller-design.md §5.2, I-23). OPAQUE: compare two values
 * with `===` only - never parse, order or do arithmetic on them. A provider
 * builds it from its own internal counters (HTTP: a counter of its own token
 * writes and cross-tab `storage` events; Tauri: the max `seq` observed from
 * the Rust session slot plus a local counter).
 */
export type CredentialRevision = string & { readonly __brand: 'CredentialRevision' };

/**
 * The kind of a session (design §5.1, ADR-0017): `'account'` (a login),
 * `'local'` (the Tauri auth-disabled mode's synthetic session), or a grant
 * kind - `'publicViewer'` (LAN viewer-public) and whatever kinds an app
 * registers on its server (e.g. `'commissioning'`). A grant kind is the SAME
 * string on the wire (`/api/auth/grant/{kind}`, `status().grants`,
 * `identity.kind`) and here; there is no translation table.
 */
export type SessionKind = 'account' | 'publicViewer' | 'local' | (string & {});

/**
 * One round-trip answer about the current session (`AuthProvider.resolve`,
 * design §2.1/§5.2):
 * - `checked`: the revision read on entry - the credential this answer
 *   validated;
 * - `current`: the revision after this call's OWN clearing of a revoked
 *   credential (equal to `checked` when it cleared nothing). So
 *   `current !== checked` iff this call cleared the credential it checked.
 */
export type ResolvedAuth =
	| { status: 'none'; checked: CredentialRevision; current: CredentialRevision }
	| {
			status: 'active';
			checked: CredentialRevision;
			current: CredentialRevision;
			identity: Identity;
			kind?: SessionKind;
	  };

/** Result of `login`/`setup`. `superseded` (Issue #260): see `AuthProvider.login`. */
export interface AuthOperationResult {
	success: boolean;
	error?: string;
	/**
	 * The credentials were accepted, but the credential this operation
	 * started from was replaced before it could store its own (another
	 * login/logout finished first, here or in another tab). Nothing was
	 * stored; `success` is `false`. Absent means `false`.
	 */
	superseded?: boolean;
}

/** Authentication abstraction used by the route guard and login page. */
export interface AuthProvider {
	/**
	 * Log in. Issue #260 (#259, I-7): a provider that tracks a
	 * `credentialRevision` stores the new credential only if the revision is
	 * still the one read when this call started; otherwise it stores nothing
	 * and resolves `{ success: false, superseded: true }`.
	 */
	login(params: Record<string, unknown>): Promise<AuthOperationResult>;
	/**
	 * Log out. Issue #260 (I-7, I-10): clears only the credential this call
	 * started from (compare-and-set) and reports the change through
	 * `onCredentialChanged`. Callers do not act on its completion: they
	 * confirm the session afterwards (`resolveSettled`), which decides
	 * whether this tab has no session now - another login may have finished
	 * meanwhile (S-51).
	 */
	logout(): Promise<void>;

	/**
	 * Has an account been created yet (spec §3.3/§8.2)? Optional so
	 * pre-existing `AuthProvider` implementations stay valid: the login page
	 * only calls this via `authProvider.status?.()` and falls back to the
	 * normal login form when it is absent (or resolves `{ initialized: true }`).
	 *
	 * `grants` (ADR-0017) reports, per grant kind, whether this server would
	 * issue it to this client right now - i.e. whether `enterGrant(kind)`
	 * below can currently succeed (`grants.publicViewer` for LAN
	 * viewer-public, viewer-public-plan §3.1-2/-6). A missing map or a
	 * missing kind reads as `false` (fail closed - no entry); the HTTP
	 * provider fills `{}` when the response has none.
	 */
	status?(): Promise<{ initialized: boolean; grants?: Record<string, boolean> }>;

	/**
	 * Create the first account and log in as it (spec §8.2's first-run
	 * setup). `params` is whatever shape the concrete provider's backend
	 * expects (username/password/displayName for the built-in providers).
	 */
	setup?(params: Record<string, unknown>): Promise<AuthOperationResult>;

	/** Change the current session's password. */
	changePassword?(current: string, next: string): Promise<{ success: boolean; error?: string }>;

	/**
	 * Obtain a credential-less grant session of `kind` (ADR-0017; the
	 * generalization of LAN viewer-public, viewer-public-plan §2.1-2.2 /
	 * ADR-0012, whose kind is `'publicViewer'`): no credentials, no bearer
	 * token on the request, and the identity/role is whatever the SERVER
	 * registered for that kind - never chosen here. Resolves
	 * `{ success: true }` and leaves the provider holding that session's
	 * token on success; resolves `{ success: false }` on any failure (404
	 * for a kind the server does not register, 403 when the kind's condition
	 * does not hold for this client, a network error) without throwing -
	 * callers (`grantFallback` in the `(app)` route guard) then leave the
	 * confirmed `none` as it is.
	 *
	 * Issue #260 (#259, design §5.2, S-20/S-52): the minted token is stored
	 * only while the credential revision is still `options.expectRevision`
	 * (default: the revision when this call started) AND no token is stored.
	 * Otherwise nothing is stored and it resolves
	 * `{ success: false, superseded: true }` - another session was
	 * established meanwhile; the caller must re-check it rather than fall
	 * back to `/login`.
	 *
	 * Optional and implemented ONLY by the HTTP provider
	 * (`createHttpAuthProvider`): the Tauri window has no LAN-facing surface
	 * for this (M11's desktop synthetic session already covers "no login in
	 * this window"), and the plain-browser demo provider has no backend to
	 * call. Both leave this undefined = unsupported (`grantFallback` then
	 * returns the `none` unchanged), same convention as `setup`/
	 * `changePassword` being absent on a provider that doesn't need them.
	 */
	enterGrant?(
		kind: SessionKind,
		options?: { expectRevision?: CredentialRevision }
	): Promise<{ success: boolean; superseded?: boolean }>;

	/**
	 * Issue #260 (design §2.1/§5.2): the current session in ONE round trip,
	 * tagged with which credential it is about. Resolves
	 * `{ status: 'none' }` only when that is established (no credential, or
	 * the backend confirmed it invalid - revoked, role changed, ...) and
	 * `{ status: 'active', identity }` for a valid one. REJECTS when the
	 * backend could not answer (a `500`, unreachable, a malformed answer) -
	 * with `StaleAnswerError` when the answer is about a credential that
	 * changed while it was in flight (a state-changing operation was still
	 * pending when it arrived, or the backend reported it stale).
	 *
	 * A `none` for a credential that was sent clears that credential with
	 * compare-and-set; the clear is NOT reported through
	 * `onCredentialChanged` but carried in the answer (`current !== checked`).
	 * A rejection never advances the revision (I-19). `signal` is the
	 * caller's per-request abort (a provider that cannot abort may ignore
	 * it).
	 *
	 * Required since v2.0.0 (with `credentialRevision`/`onCredentialChanged`,
	 * design §5.2 - the SessionController only ever asks this). A pre-#260
	 * provider with only `check()`/`getIdentity()` can be wrapped in
	 * `adaptLegacyAuthProvider` as a migration scaffold (see what it does NOT
	 * guarantee there).
	 */
	resolve(options?: { signal?: AbortSignal }): Promise<ResolvedAuth>;

	/**
	 * Issue #260 (I-23): the revision of the credential this provider holds
	 * now. Opaque - compare with `===` only. Never exposes the credential
	 * (token) itself.
	 */
	credentialRevision(): CredentialRevision;

	/**
	 * Issue #260 (I-19): subscribe to credential changes. Called - only when
	 * the revision actually changed - from the continuation that received a
	 * state-changing operation's response (login/logout/setup/
	 * changePassword/enterGrant), on a cross-tab `storage` change of
	 * the credential, and when a state-changing operation got no response.
	 * NOT called for `resolve()`'s own clearing or for a `resolve()`
	 * rejection. Returns the unsubscribe function.
	 */
	onCredentialChanged(listener: () => void): () => void;
}

/**
 * The pre-#260 `AuthProvider` shape (no `resolve`/`credentialRevision`/
 * `onCredentialChanged`) - what `adaptLegacyAuthProvider` accepts.
 * `check()`/`getIdentity()` exist only here since v2.0.0 (design §5.4):
 * `check()` resolves `false` only when the session is established invalid
 * and rejects when it could not be checked; `getIdentity()` resolves `null`
 * only when there is no session and rejects when the identity could not be
 * fetched. Grants (ADR-0017, v3.0.0) have no legacy form: an adapted
 * provider has no `enterGrant`, so `grantFallback` leaves a `none` as it is.
 */
export interface LegacyAuthProvider {
	login(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	logout(): Promise<void>;
	check(): Promise<boolean>;
	getIdentity(): Promise<Identity | null>;
	status?(): Promise<{ initialized: boolean }>;
	setup?(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	changePassword?(current: string, next: string): Promise<{ success: boolean; error?: string }>;
}

/**
 * An `AuthProvider` with the three Issue #260 methods. Since v2.0.0 they are
 * required by `AuthProvider` itself, so this is the same type (kept as an
 * alias for code written against v1.8).
 */
export type StandardAuthProvider = AuthProvider;

export type NotificationKind = 'success' | 'error' | 'info' | 'warning';

/**
 * Toast/notification sink, wired by the app (e.g. to a toast store). The app
 * calls `notify(kind, message)` directly for in-tab toasts; a server can also
 * push a toast to every connected client by broadcasting a
 * `ServerEvent::Notice { level, message }` (see `connectEvents`, which bridges
 * `notice` -> `notify`). `level` maps to `NotificationKind` when it is one of
 * the four kinds, else falls back to `'info'`.
 */
export interface Notifier {
	notify(kind: NotificationKind, message: string): void;
}
