/**
 * Test harness for the SessionController (Issue #260, design §8.1): the
 * order in which answers, timers and credential changes happen is decided
 * by the test's statements, not by fake timers.
 *
 * - `makeScheduler()` - manual timers for `deps.scheduler`; `advance(ms)`
 *   fires what is due (in order) and flushes the promise continuations.
 * - `makeProbeProvider()` - a standard `AuthProvider` whose `resolve()`
 *   answers come from `probes[n]` (settled by the test), with a revision the
 *   test moves (`change()` notifies, `bump()` does not - step 0's defense).
 *   `status()`/`enterGrant()` are deferred too.
 */
import { vi } from 'vitest';
import type {
	AuthProvider,
	CredentialRevision,
	Identity,
	ResolvedAuth,
	SessionKind
} from '../src/provider';
import { ProviderError } from '../src/errors';

export function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let every pending promise continuation run. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

type Handle = ReturnType<typeof setTimeout>;

export function makeScheduler() {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimeout(fn: () => void, ms: number): Handle {
			seq += 1;
			timers.set(seq, { at: now + ms, fn });
			return seq as unknown as Handle;
		},
		clearTimeout(handle: Handle): void {
			timers.delete(handle as unknown as number);
		},
		/** Advance the clock by `ms`, firing due timers in order. */
		async advance(ms: number): Promise<void> {
			const target = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await flush();
			}
			now = target;
			await flush();
		},
		pending(): number {
			return timers.size;
		}
	};
}

export const ALICE: Identity = { id: 'alice', name: 'Alice', role: 'admin' };
export const BOB: Identity = { id: 'bob', name: 'Bob', role: 'viewer' };
export const PUBLIC: Identity = {
	id: 'public',
	name: 'public',
	role: 'viewer',
	kind: 'publicViewer'
};
export const COMMISSIONING: Identity = { id: 'commissioning', name: 'Commissioning' };
/** What a server issues for the `commissioning` grant (ADR-0017: `identity.kind` drives the kind). */
export const COMMISSIONING_GRANT: Identity = {
	id: 'commissioning',
	name: 'Commissioning',
	role: 'admin',
	kind: 'commissioning'
};

export function serverError(): ProviderError {
	return new ProviderError({ kind: 'storage', message: 'database is locked' });
}

interface ProbeRecord {
	signal: AbortSignal | undefined;
	checked: CredentialRevision;
	settled: boolean;
	answer: ReturnType<typeof deferred<ResolvedAuth>>;
}

export function makeProbeProvider(options: { revision?: number } = {}) {
	let revision = options.revision ?? 1;
	const listeners = new Set<() => void>();
	const probes: ProbeRecord[] = [];
	const statuses: ReturnType<
		typeof deferred<{ initialized: boolean; grants?: Record<string, boolean> }>
	>[] = [];
	const entries: {
		kind: SessionKind;
		expectRevision: CredentialRevision | undefined;
		answer: ReturnType<typeof deferred<{ success: boolean; superseded?: boolean }>>;
	}[] = [];
	const rev = (n = revision) => `${n}.0` as CredentialRevision;

	const provider: AuthProvider = {
		login: vi.fn(async () => ({ success: true })),
		logout: vi.fn(async () => {}),
		status: vi.fn(() => {
			const answer = deferred<{ initialized: boolean; grants?: Record<string, boolean> }>();
			statuses.push(answer);
			return answer.promise;
		}),
		enterGrant: vi.fn((kind: SessionKind, opts?: { expectRevision?: CredentialRevision }) => {
			const answer = deferred<{ success: boolean; superseded?: boolean }>();
			entries.push({ kind, expectRevision: opts?.expectRevision, answer });
			return answer.promise;
		}),
		resolve: vi.fn((opts?: { signal?: AbortSignal }) => {
			const answer = deferred<ResolvedAuth>();
			probes.push({ signal: opts?.signal, checked: rev(), settled: false, answer });
			return answer.promise;
		}),
		credentialRevision: () => rev(),
		onCredentialChanged(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};

	function probe(index: number): ProbeRecord {
		const record = probes[index];
		if (!record) throw new Error(`no probe #${index} (have ${probes.length})`);
		if (record.settled) throw new Error(`probe #${index} already settled`);
		record.settled = true;
		return record;
	}

	return {
		provider,
		probes,
		statuses,
		entries,
		rev,
		get revision() {
			return rev();
		},
		/** The credential changed and the provider reports it (I-19). */
		change(): void {
			revision += 1;
			for (const listener of [...listeners]) listener();
		},
		/** The credential changed WITHOUT a report (step 0's defense, S-63). */
		bump(): void {
			revision += 1;
		},
		/** Set the revision directly (a provider that observed a newer seq, §10 (a)). */
		setRevision(n: number): void {
			revision = n;
		},
		/** Probes neither answered by the test nor aborted by the controller. */
		live(): number {
			return probes.filter((p) => !p.settled && !p.signal?.aborted).length;
		},
		active(
			index: number,
			identity: Identity,
			extra: { kind?: SessionKind; checked?: CredentialRevision; current?: CredentialRevision } = {}
		): void {
			const record = probe(index);
			const checked = extra.checked ?? record.checked;
			record.answer.resolve({
				status: 'active',
				checked,
				current: extra.current ?? checked,
				identity,
				...(extra.kind ? { kind: extra.kind } : {})
			});
		},
		/** `none`; `clear` = this call cleared the credential (current !== checked, not notified). */
		none(
			index: number,
			extra: { clear?: boolean; checked?: CredentialRevision; current?: CredentialRevision } = {}
		): void {
			const record = probe(index);
			const checked = extra.checked ?? record.checked;
			let current = extra.current ?? checked;
			if (extra.clear) {
				revision += 1;
				current = rev();
			}
			record.answer.resolve({ status: 'none', checked, current });
		},
		fail(index: number, error: unknown = serverError()): void {
			probe(index).answer.reject(error);
		},
		emitOnly(): void {
			for (const listener of [...listeners]) listener();
		}
	};
}
