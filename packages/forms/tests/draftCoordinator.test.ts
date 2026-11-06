/**
 * `DraftCoordinator` (shared-primitives-upstream-plan §3.5, Issue #432):
 * several dirty forms with one prompt, partial apply failure, cancel,
 * `dirty-again` when input arrives during the awaits, capture / rebind,
 * staleness through the internal request owner, re-entrant callbacks, and the
 * connection to `guardUnsavedChanges`' registry (`hasUnsavedChanges`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	createDraftCoordinator,
	type DraftCoordinator,
	type DraftSettleChoice,
	type DraftSource
} from '../src/draftCoordinator.svelte';
import { createFormDraft, draftSourceFrom } from '../src/draft.svelte';
import { hasUnsavedChanges } from '../src/unsavedChanges.svelte';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A hand-written form (no FormDraft) adapted as a DraftSource. */
function fakeForm(key: string, opts: { applyResult?: () => Promise<boolean> | boolean } = {}) {
	const state = {
		text: 'committed',
		baseline: 'committed',
		applied: 0,
		discarded: 0,
		restored: [] as unknown[]
	};
	const source: DraftSource = {
		key,
		isDirty: () => state.text !== state.baseline,
		async apply() {
			const sent = state.text;
			const ok = await (opts.applyResult?.() ?? true);
			if (ok) {
				state.baseline = sent;
				state.applied++;
			}
			return ok;
		},
		discard() {
			state.text = state.baseline;
			state.discarded++;
		},
		capture: () => ({ text: state.text, baseline: state.baseline }),
		restore(captured) {
			const c = captured as { text: string; baseline: string };
			state.text = c.text;
			state.baseline = c.baseline;
			state.restored.push(captured);
		}
	};
	return { state, source };
}

const coordinators: DraftCoordinator[] = [];
function make(): DraftCoordinator {
	const coordinator = createDraftCoordinator({ message: () => 'unsaved' });
	coordinators.push(coordinator);
	return coordinator;
}
afterEach(() => {
	for (const c of coordinators.splice(0)) c.dispose();
});

function asker(choice: DraftSettleChoice) {
	const calls: (readonly string[])[] = [];
	return {
		calls,
		ask: async (keys: readonly string[]) => {
			calls.push(keys);
			return choice;
		}
	};
}

describe('DraftCoordinator.settle', () => {
	it('returns clean without asking when nothing is dirty', async () => {
		const c = make();
		c.register(fakeForm('a').source);
		const { ask, calls } = asker('apply');
		expect(await c.settle(undefined, ask)).toBe('clean');
		expect(calls).toEqual([]);
	});

	it('asks once for several dirty forms and applies them all', async () => {
		const c = make();
		const a = fakeForm('a');
		const b = fakeForm('b');
		const clean = fakeForm('clean');
		[a, b, clean].forEach((f) => c.register(f.source));
		a.state.text = 'A';
		b.state.text = 'B';
		expect(c.pending).toBe(true);
		const { ask, calls } = asker('apply');
		expect(await c.settle(undefined, ask)).toBe('applied');
		expect(calls).toEqual([['a', 'b']]);
		expect([a.state.applied, b.state.applied, clean.state.applied]).toEqual([1, 1, 0]);
		expect(c.pending).toBe(false);
	});

	it('only the given keys are settled', async () => {
		const c = make();
		const a = fakeForm('a');
		const b = fakeForm('b');
		[a, b].forEach((f) => c.register(f.source));
		a.state.text = 'A';
		b.state.text = 'B';
		const { ask, calls } = asker('discard');
		expect(await c.settle(['b', 'unknown'], ask)).toBe('discarded');
		expect(calls).toEqual([['b']]);
		expect(a.state.text).toBe('A');
		expect(b.state.text).toBe('committed');
	});

	it('a partial apply failure returns failed; the failed form stays dirty, the other is clean', async () => {
		const c = make();
		const ok = fakeForm('ok');
		const bad = fakeForm('bad', { applyResult: () => false });
		const thrower = fakeForm('thrower', {
			applyResult: () => {
				throw new Error('boom');
			}
		});
		[ok, bad, thrower].forEach((f) => c.register(f.source));
		ok.state.text = bad.state.text = thrower.state.text = 'edit';
		expect(await c.settle(undefined, asker('apply').ask)).toBe('failed');
		expect(ok.source.isDirty()).toBe(false);
		expect(bad.source.isDirty()).toBe(true);
		expect(thrower.source.isDirty()).toBe(true);
	});

	it('cancel changes nothing', async () => {
		const c = make();
		const a = fakeForm('a');
		c.register(a.source);
		a.state.text = 'A';
		expect(await c.settle(['a'], asker('cancel').ask)).toBe('cancelled');
		expect(a.state.text).toBe('A');
		expect(a.state.applied + a.state.discarded).toBe(0);
	});

	it('returns dirty-again when input arrives while the apply is awaited (input kept)', async () => {
		const c = make();
		const gate = deferred<boolean>();
		const a = fakeForm('a', { applyResult: () => gate.promise });
		c.register(a.source);
		a.state.text = 'v1';
		const settling = c.settle(['a'], asker('apply').ask);
		await Promise.resolve();
		await Promise.resolve();
		a.state.text = 'v2';
		gate.resolve(true);
		expect(await settling).toBe('dirty-again');
		expect(a.state.baseline).toBe('v1');
		expect(a.state.text).toBe('v2');
		expect(c.pending).toBe(true);
	});

	it('with a FormDraft: v1 applies, v2 typed during the apply stays dirty -> dirty-again', async () => {
		const c = make();
		const draft = createFormDraft({
			key: 'memo',
			schema: { fields: [{ name: 'text', label: 'Text', type: 'text' }] },
			initial: { text: 'committed' }
		});
		const gate = deferred<boolean>();
		c.register(draftSourceFrom(draft, () => gate.promise));
		draft.setRaw('text', 'v1');
		const settling = c.settle(['memo'], asker('apply').ask);
		await new Promise((r) => setTimeout(r, 0));
		draft.setRaw('text', 'v2');
		gate.resolve(true);
		expect(await settling).toBe('dirty-again');
		expect(draft.baseline.text).toBe('v1');
		expect(draft.raw.text).toBe('v2');
	});

	it('starts every apply before awaiting any: input typed into a later draft during a slow apply stays dirty (#447 review)', async () => {
		const c = make();
		const mk = (key: string) =>
			createFormDraft({
				key,
				schema: { fields: [{ name: 'text', label: 'Text', type: 'text' }] },
				initial: { text: 'committed' }
			});
		const first = mk('first');
		const second = mk('second');
		const gate = deferred<boolean>();
		c.register(draftSourceFrom(first, () => gate.promise));
		c.register(draftSourceFrom(second, async () => true));
		first.setRaw('text', 'a1');
		second.setRaw('text', 'b1');
		const settling = c.settle(undefined, asker('apply').ask);
		await new Promise((r) => setTimeout(r, 0));
		second.setRaw('text', 'b2');
		gate.resolve(true);
		expect(await settling).toBe('dirty-again');
		expect(second.baseline.text).toBe('b1');
		expect(second.raw.text).toBe('b2');
		expect(second.dirty).toBe(true);
	});

	it('a target that was clean at the start is still checked at the end: edited while another apply awaits -> dirty-again (#447 review)', async () => {
		const c = make();
		const b = fakeForm('b');
		const gate = deferred<boolean>();
		const slow = fakeForm('a', { applyResult: () => gate.promise });
		c.register(slow.source);
		c.register(b.source);
		slow.state.text = 'edit';
		const settling = c.settle(['a', 'b'], asker('apply').ask);
		await new Promise((r) => setTimeout(r, 0));
		b.state.text = 'typed-meanwhile';
		gate.resolve(true);
		expect(await settling).toBe('dirty-again');
		expect(b.source.isDirty()).toBe(true);
	});

	it('a target that was clean at the start and is replaced while another apply awaits makes the settle stale (#447 review)', async () => {
		const c = make();
		const gate = deferred<boolean>();
		const slow = fakeForm('a', { applyResult: () => gate.promise });
		c.register(slow.source);
		c.register(fakeForm('b').source);
		slow.state.text = 'edit';
		const settling = c.settle(['a', 'b'], asker('apply').ask);
		await new Promise((r) => setTimeout(r, 0));
		c.register(fakeForm('b').source);
		gate.resolve(true);
		expect(await settling).toBe('stale');
	});

	it('returns dirty-again when the discard did not make the form clean', async () => {
		const c = make();
		const a = fakeForm('a');
		c.register({ ...a.source, discard: () => {} });
		a.state.text = 'A';
		expect(await c.settle(['a'], asker('discard').ask)).toBe('dirty-again');
	});

	it('is settling while running and reports pending to the unsaved-changes registry', async () => {
		const c = make();
		const gate = deferred<DraftSettleChoice>();
		const a = fakeForm('a');
		c.register(a.source);
		a.state.text = 'A';
		const settling = c.settle(['a'], () => gate.promise);
		expect(c.settling).toBe(true);
		gate.resolve('cancel');
		await settling;
		expect(c.settling).toBe(false);
	});
});

describe('DraftCoordinator staleness (internal request owner)', () => {
	it('a source replaced while asking makes the settle stale', async () => {
		const c = make();
		const a = fakeForm('a');
		c.register(a.source);
		a.state.text = 'A';
		const replacement = fakeForm('a');
		const result = await c.settle(['a'], async () => {
			c.register(replacement.source);
			return 'apply';
		});
		expect(result).toBe('stale');
		expect(a.state.applied).toBe(0);
	});

	it('a source unregistered while its apply is awaited makes the settle stale', async () => {
		const c = make();
		const gate = deferred<boolean>();
		const a = fakeForm('a', { applyResult: () => gate.promise });
		const unregister = c.register(a.source);
		a.state.text = 'A';
		const settling = c.settle(['a'], asker('apply').ask);
		await Promise.resolve();
		unregister();
		gate.resolve(true);
		expect(await settling).toBe('stale');
	});

	it('a second settle of the same key makes the first stale', async () => {
		const c = make();
		const a = fakeForm('a');
		c.register(a.source);
		a.state.text = 'A';
		const gate = deferred<DraftSettleChoice>();
		const first = c.settle(['a'], () => gate.promise);
		const second = c.settle(['a'], asker('cancel').ask);
		expect(await second).toBe('cancelled');
		gate.resolve('discard');
		expect(await first).toBe('stale');
		expect(a.state.text).toBe('A');
	});

	it('dispose while asking makes the settle stale and leaves the registry', async () => {
		const c = make();
		const a = fakeForm('a');
		c.register(a.source);
		a.state.text = 'A';
		expect(hasUnsavedChanges()).toBe(true);
		const result = await c.settle(['a'], async () => {
			c.dispose();
			return 'apply';
		});
		expect(result).toBe('stale');
		expect(a.state.applied).toBe(0);
		expect(hasUnsavedChanges()).toBe(false);
		expect(await c.settle(undefined, asker('apply').ask)).toBe('clean');
	});

	it('a re-entrant settle from inside a discard callback does not roll back the outer state', async () => {
		const c = make();
		const a = fakeForm('a');
		const b = fakeForm('b');
		let inner: Promise<string> | null = null;
		c.register({
			...a.source,
			discard() {
				a.source.discard();
				inner = c.settle(['b'], asker('discard').ask);
			}
		});
		c.register(b.source);
		a.state.text = 'A';
		b.state.text = 'B';
		expect(await c.settle(['a'], asker('discard').ask)).toBe('discarded');
		expect(await inner).toBe('discarded');
		expect(c.pending).toBe(false);
	});
});

describe('DraftCoordinator capture / rebind (dock / undock keeps input, no prompt)', () => {
	it('re-registering the same key restores the input and dirty', () => {
		const c = make();
		const first = fakeForm('pane');
		const unregister = c.register(first.source);
		first.state.text = 'unsaved';
		c.capture(['pane']);
		unregister(); // the old pane unmounts
		expect(c.pending).toBe(true); // the captured input still counts
		const remounted = fakeForm('pane'); // a fresh component starts from 'committed'
		c.register(remounted.source);
		expect(remounted.state.text).toBe('unsaved');
		expect(remounted.source.isDirty()).toBe(true);
		expect(c.pending).toBe(true);
	});

	it('works when the new pane registers before the old one unregisters', () => {
		const c = make();
		const first = fakeForm('pane');
		const unregisterOld = c.register(first.source);
		first.state.text = 'unsaved';
		c.capture(['pane']);
		const remounted = fakeForm('pane');
		c.register(remounted.source);
		unregisterOld(); // must not remove the new source
		expect(remounted.state.text).toBe('unsaved');
		expect(c.pending).toBe(true);
	});

	it('capture does not ask, apply or discard; the capture is used once', () => {
		const c = make();
		const first = fakeForm('pane');
		c.register(first.source);
		first.state.text = 'unsaved';
		c.capture(['pane', 'unknown']);
		expect(first.state.applied + first.state.discarded).toBe(0);
		const second = fakeForm('pane');
		c.register(second.source);
		const third = fakeForm('pane');
		c.register(third.source);
		expect(second.state.restored).toHaveLength(1);
		expect(third.state.restored).toHaveLength(0);
	});

	it('a capture callback that re-registers the same key does not keep the old capture (#447 review)', () => {
		const c = make();
		const old = fakeForm('pane');
		const replacement = fakeForm('pane');
		old.state.text = 'old-unsaved';
		const source: DraftSource = {
			...old.source,
			capture: () => {
				c.register(replacement.source);
				return old.source.capture!();
			}
		};
		c.register(source);
		c.capture(['pane']);
		const next = fakeForm('pane');
		c.register(next.source);
		expect(next.state.restored).toHaveLength(0);
		expect(next.state.text).toBe('committed');
	});

	it('a source without capture (FormDraft) holds nothing; the draft itself carries the input', () => {
		const c = make();
		const draft = createFormDraft({
			key: 'pane',
			schema: { fields: [{ name: 'n', label: 'N', type: 'number' }] },
			initial: { n: 1 }
		});
		const unregister = c.register(draftSourceFrom(draft, async () => true));
		draft.setRaw('n', '1e');
		c.capture(['pane']);
		unregister();
		expect(c.pending).toBe(false);
		c.register(draftSourceFrom(draft, async () => true));
		expect(draft.raw.n).toBe('1e');
		expect(c.pending).toBe(true);
	});

	it('a captured key whose pane never came back can be discarded by settle, not applied', async () => {
		const c = make();
		const first = fakeForm('pane');
		const unregister = c.register(first.source);
		first.state.text = 'unsaved';
		c.capture(['pane']);
		unregister();
		expect(await c.settle(['pane'], asker('apply').ask)).toBe('failed');
		expect(await c.settle(['pane'], asker('discard').ask)).toBe('discarded');
		expect(c.pending).toBe(false);
	});

	it('a restore that registers again re-entrantly does not resurrect the consumed capture', () => {
		const c = make();
		const first = fakeForm('pane');
		c.register(first.source);
		first.state.text = 'unsaved';
		c.capture(['pane']);
		const nested = fakeForm('pane');
		const outer = fakeForm('pane');
		c.register({
			...outer.source,
			restore(captured) {
				outer.source.restore!(captured);
				c.register(nested.source);
			}
		});
		expect(outer.state.text).toBe('unsaved');
		expect(nested.state.restored).toHaveLength(0);
	});

	it('a capture callback that disposes the coordinator holds nothing', () => {
		const c = make();
		const first = fakeForm('pane');
		c.register({
			...first.source,
			capture: () => {
				c.dispose();
				return 'x';
			}
		});
		c.capture(['pane']);
		expect(c.pending).toBe(false);
		expect(hasUnsavedChanges()).toBe(false);
	});
});

describe('DraftCoordinator and the unsaved-changes registry', () => {
	it('joins while it has sources and leaves when the last one goes', () => {
		const c = make();
		const a = fakeForm('a');
		const unregister = c.register(a.source);
		expect(hasUnsavedChanges()).toBe(false);
		a.state.text = 'A';
		expect(hasUnsavedChanges()).toBe(true);
		unregister();
		expect(hasUnsavedChanges()).toBe(false);
	});

	it('register after dispose is a no-op', () => {
		const c = make();
		c.dispose();
		const a = fakeForm('a');
		c.register(a.source)();
		a.state.text = 'A';
		expect(c.pending).toBe(false);
		expect(hasUnsavedChanges()).toBe(false);
	});
});

describe('settle never starts an apply after a synchronous re-entry made it stale (PR #447 re-review)', () => {
	function dirtySource(
		key: string,
		apply: () => Promise<boolean>
	): { source: DraftSource; calls: () => number } {
		let calls = 0;
		return {
			source: {
				key,
				isDirty: () => true,
				apply: () => {
					calls++;
					return apply();
				},
				discard: () => {}
			},
			calls: () => calls
		};
	}

	it('A.apply disposing the coordinator keeps B.apply from being called', async () => {
		const coordinator = make();
		const a = dirtySource('A', async () => {
			coordinator.dispose();
			return true;
		});
		const b = dirtySource('B', async () => true);
		coordinator.register(a.source);
		coordinator.register(b.source);
		const result = await coordinator.settle(['A', 'B'], asker('apply').ask);
		expect(result).toBe('stale');
		expect(a.calls()).toBe(1);
		expect(b.calls()).toBe(0);
	});

	it('A.apply replacing B keeps the old B.apply from being called', async () => {
		const coordinator = make();
		const replacement = dirtySource('B', async () => true);
		const a = dirtySource('A', async () => {
			coordinator.register(replacement.source);
			return true;
		});
		const b = dirtySource('B', async () => true);
		coordinator.register(a.source);
		coordinator.register(b.source);
		const result = await coordinator.settle(['A', 'B'], asker('apply').ask);
		expect(result).toBe('stale');
		expect(b.calls()).toBe(0);
		expect(replacement.calls()).toBe(0);
	});
});
