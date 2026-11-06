/**
 * `createRequestOwner` (shared-primitives-upstream-plan §3.1・D1, Issue #436).
 *
 * The first block runs the shared contract table
 * (`tests/contracts/request-owner.json`). Packages that cannot import
 * admin-core keep an internal copy of the contract and run the same table
 * with their own runner (same import-by-relative-path pattern as
 * `listOrderParity.test.ts`), so the copies cannot drift. The second block
 * covers what a table of synchronous steps cannot: real promises, the abort
 * reason seen by cancellable work, and a throwing release. (Reactivity of
 * `busy()` is `$state`-backed; this node environment runs Svelte's server
 * build, where effects do not run, so it is not asserted here.)
 */
import { describe, expect, it } from 'vitest';
import contract from './contracts/request-owner.json';
import { createRequestOwner, type RequestHandle } from '../src/request.svelte';

type Step =
	| { op: 'begin'; id: string; key?: string }
	| { op: 'hold'; id: string; resource: string }
	| { op: 'adopt'; id: string; resource: string; returns: boolean }
	| { op: 'finish'; id: string; returns: boolean }
	| { op: 'invalidate'; key?: string }
	| { op: 'dispose' }
	| { op: 'apply'; id: string; value: string }
	| { op: 'fail'; id: string; error: string }
	| {
			op: 'expect';
			current?: Record<string, boolean>;
			aborted?: Record<string, boolean>;
			busy?: Record<string, boolean>;
			released?: string[];
			model?: string | null;
			error?: string | null;
			disposed?: boolean;
	  };

const cases = (contract as unknown as { cases: { name: string; steps: Step[] }[] }).cases;

describe('request owner contract table', () => {
	it('has cases', () => {
		expect(cases.length).toBeGreaterThan(0);
	});

	for (const { name, steps } of cases) {
		it(name, () => {
			const owner = createRequestOwner();
			const handles = new Map<string, RequestHandle>();
			const released: string[] = [];
			let model: string | null = null;
			let error: string | null = null;
			const handle = (id: string): RequestHandle => {
				const found = handles.get(id);
				if (!found) throw new Error(`unknown request id ${id}`);
				return found;
			};

			steps.forEach((step, index) => {
				const at = `step ${index} (${step.op})`;
				switch (step.op) {
					case 'begin':
						handles.set(step.id, owner.begin(step.key));
						break;
					case 'hold':
						handle(step.id).hold(step.resource, (r) => released.push(r));
						break;
					case 'adopt':
						expect(handle(step.id).adopt(step.resource), at).toBe(step.returns);
						break;
					case 'finish':
						expect(handle(step.id).finish(), at).toBe(step.returns);
						break;
					case 'invalidate':
						owner.invalidate(step.key);
						break;
					case 'dispose':
						owner.dispose();
						break;
					case 'apply':
						if (handle(step.id).isCurrent()) model = step.value;
						break;
					case 'fail':
						if (handle(step.id).isCurrent()) error = step.error;
						break;
					case 'expect':
						for (const [id, value] of Object.entries(step.current ?? {}))
							expect(handle(id).isCurrent(), `${at} current ${id}`).toBe(value);
						for (const [id, value] of Object.entries(step.aborted ?? {}))
							expect(handle(id).signal.aborted, `${at} aborted ${id}`).toBe(value);
						for (const [key, value] of Object.entries(step.busy ?? {}))
							expect(owner.busy(key), `${at} busy "${key}"`).toBe(value);
						if (step.released) expect(released, `${at} released`).toEqual(step.released);
						if ('model' in step) expect(model, `${at} model`).toBe(step.model);
						if ('error' in step) expect(error, `${at} error`).toBe(step.error);
						if (step.disposed !== undefined)
							expect(owner.disposed, `${at} disposed`).toBe(step.disposed);
						break;
				}
			});
		});
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('createRequestOwner with real async work', () => {
	it('discards the result of work that cannot be aborted when a later request finished first', async () => {
		const owner = createRequestOwner();
		const slow = deferred<string>();
		const fast = deferred<string>();
		let model = 'initial';
		let loading = false;

		async function load(work: Promise<string>): Promise<void> {
			const request = owner.begin();
			loading = true;
			try {
				const value = await work; // ignores request.signal on purpose
				if (!request.isCurrent()) return;
				model = value;
			} finally {
				if (request.finish()) loading = false;
			}
		}

		const first = load(slow.promise);
		const second = load(fast.promise);
		fast.resolve('new');
		await second;
		expect(model).toBe('new');
		expect(loading).toBe(false);
		slow.resolve('old');
		await first;
		expect(model).toBe('new');
		expect(loading).toBe(false);
	});

	it('aborts the signal of cancellable work with an AbortError when superseded', async () => {
		const owner = createRequestOwner();
		const first = owner.begin();
		const aborted = new Promise<unknown>((resolve) =>
			first.signal.addEventListener('abort', () => resolve(first.signal.reason))
		);
		owner.begin();
		const reason = await aborted;
		expect(reason).toBeInstanceOf(DOMException);
		expect((reason as DOMException).name).toBe('AbortError');
	});

	it('a stale rejection does not overwrite the error of the current request', async () => {
		const owner = createRequestOwner();
		let error: string | null = null;
		const run = async (work: Promise<never>) => {
			const request = owner.begin();
			try {
				await work;
			} catch (err) {
				if (request.isCurrent()) error = String(err);
			} finally {
				request.finish();
			}
		};
		const old = deferred<never>();
		const current = deferred<never>();
		const a = run(old.promise);
		const b = run(current.promise);
		current.reject('current failure');
		await b;
		old.reject('stale failure');
		await a;
		expect(error).toBe('current failure');
	});

	it('releases a temporary resource once when the owner is disposed mid-request (unmount)', async () => {
		const owner = createRequestOwner();
		const work = deferred<void>();
		const revoked: string[] = [];
		const done = (async () => {
			const request = owner.begin();
			try {
				const url = request.hold('blob:1', (u) => revoked.push(u));
				await work.promise;
				if (request.adopt(url)) throw new Error('must not adopt after dispose');
			} finally {
				request.finish();
			}
		})();
		owner.dispose();
		expect(revoked).toEqual(['blob:1']);
		work.resolve();
		await done;
		expect(revoked).toEqual(['blob:1']);
	});

	it('calls every release even if one throws, then rethrows the first failure', () => {
		const owner = createRequestOwner();
		const request = owner.begin();
		const released: string[] = [];
		request.hold('a', () => {
			throw new Error('boom');
		});
		request.hold('b', (r) => released.push(r));
		expect(() => request.finish()).toThrow('boom');
		expect(released).toEqual(['b']);
		expect(owner.busy()).toBe(false);
	});
});

describe('createRequestOwner with re-entrant callbacks (PR #441 review)', () => {
	it('an abort listener that disposes the owner leaves the new request stale too', () => {
		const owner = createRequestOwner();
		const a = owner.begin();
		a.signal.addEventListener('abort', () => owner.dispose());
		const b = owner.begin();
		expect(owner.disposed).toBe(true);
		expect(b.isCurrent()).toBe(false);
		expect(b.signal.aborted).toBe(true);
		expect(owner.busy()).toBe(false);
		const released: string[] = [];
		b.hold('r', (r) => released.push(r));
		expect(released).toEqual(['r']);
	});

	it('an abort listener that begins again supersedes the outer begin', () => {
		const owner = createRequestOwner();
		const a = owner.begin();
		let inner: ReturnType<typeof owner.begin> | null = null;
		a.signal.addEventListener('abort', () => {
			inner = owner.begin();
		});
		const outer = owner.begin();
		expect(outer.isCurrent()).toBe(false);
		expect(inner!.isCurrent()).toBe(true);
		expect(owner.busy()).toBe(true);
	});

	it('invalidate does not delete a request begun from the abort listener', () => {
		const owner = createRequestOwner();
		const a = owner.begin();
		let next: ReturnType<typeof owner.begin> | null = null;
		a.signal.addEventListener('abort', () => {
			next = owner.begin();
		});
		owner.invalidate();
		expect(next!.isCurrent()).toBe(true);
		expect(owner.busy()).toBe(true);
	});

	it('finish answers false when a release callback began a newer request', () => {
		const owner = createRequestOwner();
		const a = owner.begin();
		let b: ReturnType<typeof owner.begin> | null = null;
		a.hold('r', () => {
			b = owner.begin();
		});
		expect(a.finish()).toBe(false);
		expect(b!.isCurrent()).toBe(true);
		expect(owner.busy()).toBe(true);
	});
});

describe('createRequestOwner during dispose (PR #441 review)', () => {
	it('a release callback of one key cannot adopt the resource of another key', () => {
		const owner = createRequestOwner();
		const a = owner.begin('a');
		const b = owner.begin('b');
		const released: string[] = [];
		b.hold('resource', (r) => released.push(r));
		let adopted: boolean | null = null;
		a.hold('cleanup', () => {
			adopted = b.adopt('resource');
		});
		owner.dispose();
		expect(owner.disposed).toBe(true);
		expect(adopted).toBe(false);
		expect(released).toEqual(['resource']);
	});

	it('an abort listener of one key sees another key as stale and cannot adopt', () => {
		const owner = createRequestOwner();
		const a = owner.begin('a');
		const b = owner.begin('b');
		b.hold('resource', () => {});
		let current: boolean | null = null;
		let adopted: boolean | null = null;
		a.signal.addEventListener('abort', () => {
			current = b.isCurrent();
			adopted = b.adopt('resource');
		});
		owner.dispose();
		expect(current).toBe(false);
		expect(adopted).toBe(false);
	});
});
