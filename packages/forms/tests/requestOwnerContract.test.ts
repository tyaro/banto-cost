/**
 * The package-internal request owner (`src/requestOwner.svelte.ts`) against
 * admin-core's contract table (shared-primitives-upstream-plan §3.5・§4.1・D1,
 * Issue #432 / #436). forms cannot import admin-core (plan §2.1), so it keeps
 * its own copy of the contract; reading the SAME JSON by relative path (the
 * `listOrderParity.test.ts` pattern in admin-core) keeps the copies from
 * drifting. This is our own runner, mirroring admin-core's
 * `tests/requestOwner.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import contract from '../../admin-core/tests/contracts/request-owner.json';
import { createRequestOwner, type RequestHandle } from '../src/requestOwner.svelte';

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

const KNOWN_OPS = new Set([
	'begin',
	'hold',
	'adopt',
	'finish',
	'invalidate',
	'dispose',
	'apply',
	'fail',
	'expect'
]);
const cases = (contract as unknown as { cases: { name: string; steps: Step[] }[] }).cases;

describe('request owner contract table (admin-core) on the forms-internal copy', () => {
	it('reads the shared table and knows every op in it', () => {
		expect(cases.length).toBeGreaterThan(0);
		// A new op added to the table must fail here rather than be skipped silently.
		for (const { steps } of cases) for (const step of steps) expect(KNOWN_OPS).toContain(step.op);
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
