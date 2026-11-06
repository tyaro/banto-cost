/**
 * The session half of a minimal v2 `AuthProvider` for tests that only need
 * `initBanto` to accept one (Issue #260 実装-3: `resolve`/
 * `credentialRevision`/`onCredentialChanged` are required). It answers
 * "no session" and never reports a credential change. Spread it next to
 * `login`/`logout`.
 */
import type { AuthProvider, CredentialRevision } from '../src/provider';

const STUB_REVISION = '0.0' as CredentialRevision;

export const STUB_SESSION: Pick<
	AuthProvider,
	'resolve' | 'credentialRevision' | 'onCredentialChanged'
> = {
	resolve: async () => ({ status: 'none', checked: STUB_REVISION, current: STUB_REVISION }),
	credentialRevision: () => STUB_REVISION,
	onCredentialChanged: () => () => {}
};
