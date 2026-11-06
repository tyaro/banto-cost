/**
 * Compatibility adapter for a pre-#260 `AuthProvider` (Issue #260,
 * docs/design/session-controller-design.md §5.2, owner decision 2).
 *
 * A scaffold for moving a hand-written provider onto the v2 contract, NOT a
 * full implementation of it. It fills in `resolve`/`credentialRevision`/
 * `onCredentialChanged` from the legacy `check()`/`getIdentity()` so the
 * types line up, and documents - and its tests pin down - what it can and
 * cannot guarantee:
 *
 * Guaranteed:
 * - `resolve()`'s shape: `check()` `false` -> `none`; `true` -> one
 *   `getIdentity()`, an identity -> `active`; either rejecting -> reject.
 *   `check()` `true` with `getIdentity()` `null` REJECTS (it is not squashed
 *   into an "active session without identity");
 * - `checked`/`current`/`credentialRevision()` are always the constant
 *   `ADAPTER_REVISION`, and `onCredentialChanged` accepts listeners but
 *   never calls them;
 * - `login`/`logout`/`setup`/`changePassword`/`status` pass through. There
 *   is no `enterGrant` (grants are a v3.0.0 contract, ADR-0017, with no
 *   legacy form), so `grantFallback` leaves a `none` as it is. The legacy
 *   `check()`/`getIdentity()` are only used by `resolve()` (they are not
 *   part of the v2 `AuthProvider`).
 *
 * NOT guaranteed:
 * - one round trip: the credential can change between `check()` and
 *   `getIdentity()`, and the adapter cannot tell (no revision);
 * - the safety of `check()`'s side effects (whether it clears a token), or
 *   compare-and-set on any credential write - the #259 race stays;
 *   `expectRevision` is ignored;
 * - detecting a credential switch in another tab (I-5/I-17/I-19 do not
 *   apply).
 *
 * Migrate by implementing the three methods on the provider itself (for
 * HTTP: one `GET /api/auth/identity`), or by switching to the admin-core
 * providers. The logout flow also relies on the provider: after
 * `logout()` the app asks `resolveSettled()` (never `end()`, I-10), so an
 * adapted `logout()` must leave the legacy `check()` answering `false`.
 */
import type {
	AuthProvider,
	CredentialRevision,
	LegacyAuthProvider,
	ResolvedAuth
} from '../provider';
import { ProviderError } from '../errors';

/** The fixed revision every adapted provider reports (see the module doc). */
export const ADAPTER_REVISION = '0.0' as CredentialRevision;

/** Wrap a pre-#260 `AuthProvider` so it satisfies the v2 contract's shape. */
export function adaptLegacyAuthProvider(legacy: LegacyAuthProvider): AuthProvider {
	const adapted: AuthProvider = {
		login: (params) => legacy.login(params),
		logout: () => legacy.logout(),

		async resolve(): Promise<ResolvedAuth> {
			const valid = await legacy.check();
			if (!valid) {
				return { status: 'none', checked: ADAPTER_REVISION, current: ADAPTER_REVISION };
			}
			const identity = await legacy.getIdentity();
			if (identity === null) {
				throw new ProviderError({
					kind: 'other',
					message: 'check() reported a valid session but getIdentity() returned null'
				});
			}
			return {
				status: 'active',
				checked: ADAPTER_REVISION,
				current: ADAPTER_REVISION,
				identity
			};
		},

		credentialRevision: () => ADAPTER_REVISION,

		onCredentialChanged(): () => void {
			// Never called: the legacy provider has no way to report a change.
			return () => {};
		}
	};
	if (legacy.status) {
		const status = legacy.status.bind(legacy);
		adapted.status = () => status();
	}
	if (legacy.setup) {
		const setup = legacy.setup.bind(legacy);
		adapted.setup = (params) => setup(params);
	}
	if (legacy.changePassword) {
		const changePassword = legacy.changePassword.bind(legacy);
		adapted.changePassword = (current, next) => changePassword(current, next);
	}
	return adapted;
}
