import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProviderError, isStaleAnswerError } from '../src/errors';
import { createTauriAuthProvider } from '../src/providers/tauri';

/**
 * Issue #260 実装-1 (docs/design/session-controller-design.md §5.3, §8.2): the
 * Tauri provider's `(observedSeq, local)` revision, `auth_resolve`, the
 * stale rule for answers that cross a pending state-changing command, and
 * change notifications. The Rust commands are replaced by a scripted
 * `invoke` whose every call waits on its own deferred, so the test fixes
 * the order responses arrive in. Test names start with the scenario number
 * (S-n) of design §4.
 */

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function scriptedInvoke() {
	const calls: { cmd: string; args?: Record<string, unknown>; reply: Deferred<unknown> }[] = [];
	const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
		const reply = deferred<unknown>();
		calls.push({ cmd, args, reply });
		return reply.promise;
	});
	/** The most recent call of `cmd`. */
	const last = (cmd: string) => {
		const found = calls.filter((call) => call.cmd === cmd).at(-1);
		if (!found) throw new Error(`no ${cmd} call`);
		return found;
	};
	return { calls, invoke, last };
}

function setup(opPendingTimeoutMs?: number) {
	const script = scriptedInvoke();
	const auth = createTauriAuthProvider({ invoke: script.invoke, opPendingTimeoutMs });
	const changed = vi.fn();
	auth.onCredentialChanged(changed);
	return { ...script, auth, changed };
}

const A = { id: 'a', name: 'A', role: 'admin' };
const B = { id: 'b', name: 'B', role: 'admin' };

function resolveAnswer(
	identity: typeof A | null,
	checked: number,
	current = checked,
	extra: Record<string, unknown> = {}
) {
	return {
		identity,
		kind: identity ? 'account' : null,
		checked,
		current,
		stale: false,
		...extra
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('Tauri revision from operation responses (I-19, I-23)', () => {
	it('S-55: a login response seq advances the revision and notifies in that continuation; a failing auth_resolve afterwards changes nothing', async () => {
		const { auth, changed, last } = setup();
		expect(auth.credentialRevision()).toBe('0.0');

		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await expect(login).resolves.toEqual({ success: true });
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).toHaveBeenCalledTimes(1);

		const resolving = auth.resolve();
		last('auth_resolve').reply.reject({ kind: 'storage', message: 'database is locked' });
		const err = await resolving.catch((e: unknown) => e);

		expect(isProviderError(err)).toBe(true);
		expect(isStaleAnswerError(err)).toBe(false);
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-16 (provider half): a superseded login reports superseded; its seq (unchanged) does not notify', async () => {
		const { auth, changed, last } = setup();
		const logout = auth.logout();
		last('auth_logout').reply.resolve({ seq: 1 });
		await logout;
		expect(changed).toHaveBeenCalledTimes(1);

		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({
			success: false,
			error: '別のセッションが先に確定したため、このログインは適用されませんでした',
			superseded: true,
			seq: 1
		});

		await expect(login).resolves.toMatchObject({ success: false, superseded: true });
		expect(auth.credentialRevision()).toBe('1.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-95 (provider half): a login refused in auth-disabled mode keeps the revision, reports nothing, and carries the error', async () => {
		const { auth, changed, last } = setup();
		const resolve = auth.resolve();
		last('auth_resolve').reply.resolve({
			identity: { id: '0', name: 'ローカルユーザー', role: 'admin' },
			kind: 'local',
			checked: 3,
			current: 3,
			stale: false
		});
		await resolve;
		const before = auth.credentialRevision();

		const login = auth.login({ username: 'admin', password: 'pw' });
		last('auth_login').reply.resolve({
			success: false,
			error:
				'ログイン不要モード中はアカウントでログインできません。設定で通常のログインに戻してください',
			superseded: false,
			seq: 3
		});

		await expect(login).resolves.toEqual({
			success: false,
			error:
				'ログイン不要モード中はアカウントでログインできません。設定で通常のログインに戻してください'
		});
		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-17 (provider half): an overtaken logout returns the seq the login already reported - no notification', async () => {
		const { auth, changed, last } = setup();
		const logout = auth.logout();
		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 1 });
		await login;
		expect(changed).toHaveBeenCalledTimes(1);

		last('auth_logout').reply.resolve({ seq: 1 });
		await logout;

		expect(auth.credentialRevision()).toBe('1.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-67: the auth-disabled logout no-op (same seq) does not notify', async () => {
		const { auth, changed, last } = setup();
		const first = auth.resolve();
		last('auth_resolve').reply.resolve({
			...resolveAnswer({ id: 'local', name: 'ローカルユーザー', role: 'admin' } as typeof A, 3),
			kind: 'local'
		});
		await first;
		changed.mockClear();

		const logout = auth.logout();
		last('auth_logout').reply.resolve({ seq: 3 });
		await logout;

		expect(auth.credentialRevision()).toBe('3.0');
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-68: auth_change_password returning an advanced seq notifies once', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'a', password: 'pw' });
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 1 });
		await login;
		changed.mockClear();

		const change = auth.changePassword?.('pw', 'new-password1');
		last('auth_change_password').reply.resolve({ seq: 2 });

		await expect(change).resolves.toEqual({ success: true });
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('responses arriving out of order never rewind observedSeq', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		const logout = auth.logout();
		last('auth_logout').reply.resolve({ seq: 3 });
		await logout;
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await login;

		expect(auth.credentialRevision()).toBe('3.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-55: an unrecognizable (IPC) rejection of a state-changing invoke advances local and notifies; a later lower seq does not move it', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await login;
		changed.mockClear();

		const logout = auth.logout();
		last('auth_logout').reply.reject('ipc failed');
		await expect(logout).rejects.toSatisfy(isProviderError);
		expect(auth.credentialRevision()).toBe('2.1');
		expect(changed).toHaveBeenCalledTimes(1);

		const change = auth.changePassword?.('pw', 'new-password1');
		last('auth_change_password').reply.resolve({ seq: 2 });
		await change;
		expect(auth.credentialRevision()).toBe('2.1');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('an older backend without seq in its responses still works (no revision change)', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({ success: true });
		await expect(login).resolves.toEqual({ success: true });
		const logout = auth.logout();
		last('auth_logout').reply.resolve(null);
		await logout;

		expect(auth.credentialRevision()).toBe('0.0');
		expect(changed).not.toHaveBeenCalled();
	});
});

describe('Tauri resolve(): auth_resolve once (§5.3)', () => {
	it('S-54: re-resolving the same session (checked === current) keeps the revision and never notifies', async () => {
		const { auth, changed, last } = setup();
		for (const name of ['A', 'A', 'A（改名）']) {
			const resolving = auth.resolve();
			expect(last('auth_resolve').args).toBeUndefined();
			last('auth_resolve').reply.resolve(resolveAnswer({ ...A, name }, 1));
			const answer = await resolving;
			expect(answer).toEqual({
				status: 'active',
				checked: '1.0',
				current: '1.0',
				identity: { ...A, name },
				kind: 'account'
			});
		}
		expect(auth.credentialRevision()).toBe('1.0');
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-64: a resolve that cleared a revoked session carries current !== checked, without notifying', async () => {
		const { auth, changed, last } = setup();
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve(resolveAnswer(null, 1, 2));

		const answer = await resolving;

		expect(answer).toEqual({ status: 'none', checked: '1.0', current: '2.0' });
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-47: the auth-disabled session resolves with kind local', async () => {
		const { auth, last } = setup();
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve({
			...resolveAnswer({ id: 'local', name: 'ローカルユーザー', role: 'viewer' } as typeof A, 0),
			kind: 'local'
		});

		await expect(resolving).resolves.toMatchObject({ status: 'active', kind: 'local' });
	});

	it('S-77/S-97: an answer the backend reports stale rejects with StaleAnswerError, but its `current` is observed (I-23), without a notification', async () => {
		const { auth, changed, last } = setup();
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve({ ...resolveAnswer(null, 1, 2), stale: true });

		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).not.toHaveBeenCalled();
	});

	// S-100 (re-review of #266 P1): an `auth_resolve` `current` seen while a
	// state-changing command is pending is kept and collected when the last
	// pending command ends - in the same continuation as that command's own
	// `seq`, so there is exactly one notification.
	it('S-100: a stale `current` seen during a pending command is collected when the command fails without a seq (one notification)', async () => {
		const { auth, changed, last } = setup();
		const changing = auth.changePassword!('old', 'newpassword');
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve({ ...resolveAnswer(null, 1, 2), stale: true });
		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);
		expect(auth.credentialRevision()).toBe('0.0'); // kept, not observed yet

		last('auth_change_password').reply.reject({ kind: 'forbidden' });
		await expect(changing).resolves.toMatchObject({ success: false });
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-100: the command answers with a newer seq - one notification, its seq', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve({ ...resolveAnswer(B, 1, 2), stale: true });
		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);

		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 3 });
		await login;
		expect(auth.credentialRevision()).toBe('3.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-75/S-100: the command answers with the same seq as the kept one - one notification', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve({ ...resolveAnswer(B, 1, 2), stale: true });
		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);
		expect(auth.credentialRevision()).toBe('0.0');

		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await login;
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-100: with two pending commands the kept seq waits for the last one', async () => {
		const { auth, changed, calls } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		const changing = auth.changePassword!('old', 'newpassword');
		const resolving = auth.resolve();
		calls
			.filter((c) => c.cmd === 'auth_resolve')
			.at(-1)!
			.reply.resolve({
				...resolveAnswer(null, 1, 4),
				stale: true
			});
		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);

		calls
			.find((c) => c.cmd === 'auth_change_password')!
			.reply.reject({ kind: 'storage', message: 'database is locked' });
		await changing;
		expect(auth.credentialRevision()).toBe('0.0'); // the login is still pending
		expect(changed).not.toHaveBeenCalled();

		calls
			.find((c) => c.cmd === 'auth_login')!
			.reply.resolve({
				success: false,
				error: 'bad credentials',
				superseded: false,
				seq: 1
			});
		await login;
		expect(auth.credentialRevision()).toBe('4.0');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-78/S-100: a command that times out collects the kept seq with its local advance - one notification', async () => {
		vi.useFakeTimers();
		const { auth, changed, last } = setup(1_000);
		void auth.login({ username: 'a', password: 'pw' });
		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve({ ...resolveAnswer(null, 1, 3), stale: true });
		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);

		vi.advanceTimersByTime(1_000);
		expect(auth.credentialRevision()).toBe('3.1');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-73: an old auth_resolve answer arriving after a newer login response is tagged with its own (older) checked', async () => {
		const { auth, changed, last } = setup();
		const resolving = auth.resolve(); // Rust seq_at_entry 1
		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await login;
		last('auth_resolve').reply.resolve(resolveAnswer(A, 1));

		const answer = await resolving;

		expect(answer.checked).toBe('1.0');
		// observedSeq is a max: the old answer did not rewind it.
		expect(auth.credentialRevision()).toBe('2.0');
		// So a caller comparing `current` with the revision now discards it.
		expect(answer.current).not.toBe(auth.credentialRevision());
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-75: an auth_resolve answer arriving while a login (started earlier) is pending is stale; the login then notifies', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'b', password: 'pw' });
		const resolving = auth.resolve();
		// Rust settled the resolve before installing B: none, seq 1.
		last('auth_resolve').reply.resolve(resolveAnswer(null, 1));

		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);
		expect(changed).not.toHaveBeenCalled();

		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await login;
		expect(changed).toHaveBeenCalledTimes(1);
		const again = auth.resolve();
		last('auth_resolve').reply.resolve(resolveAnswer(B, 2));
		await expect(again).resolves.toMatchObject({ status: 'active', identity: B, checked: '2.0' });
	});

	it('S-82: the same when the login started AFTER the resolve (a start-time rule would wrongly accept the old none)', async () => {
		const { auth, last } = setup();
		const resolving = auth.resolve();
		const login = auth.login({ username: 'b', password: 'pw' });
		last('auth_resolve').reply.resolve(resolveAnswer(null, 1));

		await expect(resolving).rejects.toSatisfy(isStaleAnswerError);

		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await login;
		expect(auth.credentialRevision()).toBe('2.0');
	});

	it('S-78: a login that never answers stops blocking after opPendingTimeoutMs (local advances, notifies); its late answer is still observed', async () => {
		vi.useFakeTimers();
		const { auth, changed, last, calls } = setup(1_000);
		const loginA = auth.login({ username: 'a', password: 'pw' });
		const loginACall = last('auth_login');
		const loginB = auth.login({ username: 'b', password: 'pw' });
		last('auth_login').reply.resolve({ success: true, error: null, superseded: false, seq: 2 });
		await loginB;
		expect(auth.credentialRevision()).toBe('2.0');
		expect(changed).toHaveBeenCalledTimes(1);

		// A is still pending: answers are stale until its deadline.
		const blocked = auth.resolve();
		last('auth_resolve').reply.resolve(resolveAnswer(B, 2));
		await expect(blocked).rejects.toSatisfy(isStaleAnswerError);

		vi.advanceTimersByTime(1_000);
		expect(auth.credentialRevision()).toBe('2.1');
		expect(changed).toHaveBeenCalledTimes(2);

		const resolving = auth.resolve();
		last('auth_resolve').reply.resolve(resolveAnswer(B, 2));
		await expect(resolving).resolves.toMatchObject({
			status: 'active',
			identity: B,
			checked: '2.1',
			current: '2.1'
		});

		// A's late answer (Rust superseded it at seq 2) moves nothing.
		loginACall.reply.resolve({
			success: false,
			error: 'superseded',
			superseded: true,
			seq: 2
		});
		await expect(loginA).resolves.toMatchObject({ superseded: true });
		expect(auth.credentialRevision()).toBe('2.1');
		expect(changed).toHaveBeenCalledTimes(2);
		expect(calls.filter((c) => c.cmd === 'auth_login')).toHaveLength(2);
	});

	it.each([
		['an IPC error', new Error('ipc channel closed')],
		['unauthorized', { kind: 'unauthorized' }]
	])(
		'S-78: a timed-out op whose late answer is a rejection (%s) advances local only once and notifies once',
		async (_label, rejection) => {
			vi.useFakeTimers();
			const { auth, changed, last } = setup(1_000);
			const before = auth.credentialRevision();
			const logout = auth.logout();
			const logoutCall = last('auth_logout');

			vi.advanceTimersByTime(1_000);
			expect(auth.credentialRevision()).toBe('0.1');
			expect(auth.credentialRevision()).not.toBe(before);
			expect(changed).toHaveBeenCalledTimes(1);

			// The late rejection is the same unknown outcome the timeout
			// already accounted for: no second bump.
			logoutCall.reply.reject(rejection);
			await expect(logout).rejects.toSatisfy(isProviderError);
			expect(auth.credentialRevision()).toBe('0.1');
			expect(changed).toHaveBeenCalledTimes(1);
		}
	);

	it('S-26: a failed auth_resolve (IPC / backend error) never advances the revision', async () => {
		const { auth, changed, last } = setup();
		const resolving = auth.resolve();
		last('auth_resolve').reply.reject({ kind: 'other', message: 'boom' });

		await expect(resolving).rejects.toSatisfy(isProviderError);
		expect(auth.credentialRevision()).toBe('0.0');
		expect(changed).not.toHaveBeenCalled();
	});

	it('setup: a validation rejection resolves { success: false, error } and, returned before any slot write, changes nothing', async () => {
		const { auth, changed, last } = setup();
		const result = auth.setup?.({ username: 'owner', password: 'short', displayName: 'O' });
		last('auth_setup').reply.reject({
			kind: 'validation',
			field_errors: [{ field: 'password', message: 'パスワードは8文字以上で入力してください' }]
		});

		await expect(result).resolves.toEqual({
			success: false,
			error: 'パスワードは8文字以上で入力してください'
		});
		expect(auth.credentialRevision()).toBe('0.0');
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-55: a wrong current password (a validation error, returned before any slot write) keeps the revision and does not notify', async () => {
		const { auth, changed, last } = setup();
		const change = auth.changePassword?.('wrong', 'new-password1');
		last('auth_change_password').reply.reject({
			kind: 'validation',
			field_errors: [{ field: 'currentPassword', message: '現在のパスワードが違います' }]
		});

		await expect(change).resolves.toEqual({ success: false, error: '現在のパスワードが違います' });
		expect(auth.credentialRevision()).toBe('0.0');
		expect(changed).not.toHaveBeenCalled();
	});

	it('S-55: an unauthorized rejection (the session check may have cleared a revoked session first) advances local and notifies', async () => {
		const { auth, changed, last } = setup();
		const change = auth.changePassword?.('pw', 'new-password1');
		last('auth_change_password').reply.reject({ kind: 'unauthorized' });

		await expect(change).resolves.toMatchObject({ success: false });
		expect(auth.credentialRevision()).toBe('0.1');
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('S-55: other structured errors (storage, forbidden) of login/logout keep the revision; an Error object advances it', async () => {
		const { auth, changed, last } = setup();
		const login = auth.login({ username: 'a', password: 'pw' });
		last('auth_login').reply.reject({ kind: 'storage', message: 'database is locked' });
		await expect(login).rejects.toSatisfy(isProviderError);
		const logout = auth.logout();
		last('auth_logout').reply.reject({ kind: 'forbidden' });
		await expect(logout).rejects.toSatisfy(isProviderError);
		expect(auth.credentialRevision()).toBe('0.0');
		expect(changed).not.toHaveBeenCalled();

		const dropped = auth.logout();
		last('auth_logout').reply.reject(new Error('ipc channel closed'));
		await expect(dropped).rejects.toSatisfy(isProviderError);
		expect(auth.credentialRevision()).toBe('0.1');
		expect(changed).toHaveBeenCalledTimes(1);
	});
});
