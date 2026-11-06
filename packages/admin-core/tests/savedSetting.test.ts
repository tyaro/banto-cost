/**
 * `createSavedSetting` (shared-primitives-upstream-plan §3.4, Issue #437).
 * Runs against an injected `UiSettingsProvider` whose every call is a
 * manually settled promise, so success, failure, delay and answer order are
 * controlled by the test. (Reactivity is `$state`-backed; this node
 * environment runs Svelte's server build where effects do not run, so it is
 * not asserted here.)
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors';
import type { UiSettingsProvider } from '../src/providers/uiSettings';
import {
	createSavedSetting,
	type SavedSetting,
	type SavedSettingOptions
} from '../src/savedSetting.svelte';

interface Pending<R> {
	args: unknown[];
	resolve: (value: R) => void;
	reject: (error: unknown) => void;
}

function manualProvider() {
	const gets: Pending<string | null>[] = [];
	const sets: Pending<void>[] = [];
	const provider: UiSettingsProvider = {
		get: (key) =>
			new Promise((resolve, reject) => {
				gets.push({ args: [key], resolve, reject });
			}),
		set: (key, value) =>
			new Promise((resolve, reject) => {
				sets.push({ args: [key, value], resolve, reject });
			})
	};
	return { provider, gets, sets };
}

interface Pos {
	x: number;
}

function options(
	provider: UiSettingsProvider,
	extra: Partial<SavedSettingOptions<Pos>> = {}
): SavedSettingOptions<Pos> {
	return {
		provider,
		key: 'layout',
		parse: (raw: string) => {
			const o = JSON.parse(raw) as { v?: number; x?: unknown };
			return o.v === 1 && typeof o.x === 'number' ? { x: o.x } : undefined;
		},
		serialize: (value: Pos) => JSON.stringify({ v: 1, x: value.x }),
		fallback: () => ({ x: 0 }),
		...extra
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const raw = (x: number) => JSON.stringify({ v: 1, x });

describe('save', () => {
	it('updates saved only after the provider succeeds', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 5 });
		expect(s.dirty).toBe(true);
		const done = s.save();
		expect(s.saving).toBe(true);
		expect(s.saved).toBeUndefined();
		expect(m.sets[0].args).toEqual(['layout', raw(5)]);
		m.sets[0].resolve();
		expect(await done).toBe(true);
		expect(s.saved).toEqual({ x: 5 });
		expect(s.saving).toBe(false);
		expect(s.dirty).toBe(false);
		expect(s.error).toBeNull();
	});

	it('keeps current and the previous saved on failure, and clears error on the next success', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const first = s.save();
		m.sets[0].resolve();
		await first;
		s.set({ x: 2 });
		const second = s.save();
		const failure = new ProviderError({ kind: 'storage', message: 'disk' });
		m.sets[1].reject(failure);
		expect(await second).toBe(false);
		expect(s.error).toBe(failure);
		expect(s.current).toEqual({ x: 2 });
		expect(s.saved).toEqual({ x: 1 });
		expect(s.dirty).toBe(true);
		const third = s.save();
		m.sets[2].resolve();
		expect(await third).toBe(true);
		expect(s.error).toBeNull();
		expect(s.saved).toEqual({ x: 2 });
	});

	it('treats a synchronous provider throw as a failure', async () => {
		const provider: UiSettingsProvider = {
			get: async () => null,
			set: () => {
				throw new ProviderError({ kind: 'other', message: 'invalid ui-settings key' });
			}
		};
		const s = createSavedSetting(options(provider));
		expect(await s.save()).toBe(false);
		expect(s.error).toBeInstanceOf(ProviderError);
		expect(s.saving).toBe(false);
	});

	it('marks the snapshot that was sent, not an edit made during the send', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const done = s.save();
		s.set({ x: 2 }); // edited while x=1 is in flight
		m.sets[0].resolve();
		await done;
		expect(s.saved).toEqual({ x: 1 });
		expect(s.current).toEqual({ x: 2 });
		expect(s.dirty).toBe(true);
	});
});

describe('concurrent saves (serialized and coalesced)', () => {
	it('sends one at a time and coalesces saves made meanwhile into one follow-up with the latest value', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		s.set({ x: 2 });
		const b = s.save();
		s.set({ x: 3 });
		const c = s.save();
		expect(m.sets).toHaveLength(1); // nothing else started
		m.sets[0].resolve();
		expect(await a).toBe(true);
		await flush();
		expect(m.sets).toHaveLength(2);
		expect(m.sets[1].args).toEqual(['layout', raw(3)]); // latest, not x=2
		m.sets[1].resolve();
		expect(await Promise.all([b, c])).toEqual([true, true]);
		expect(s.saved).toEqual({ x: 3 });
		expect(s.dirty).toBe(false);
		expect(m.sets).toHaveLength(2);
	});

	it('sends the follow-up after a failure (a retry with the latest value)', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		s.set({ x: 2 });
		const b = s.save();
		m.sets[0].reject(new Error('net'));
		expect(await a).toBe(false);
		await flush();
		m.sets[1].resolve();
		expect(await b).toBe(true);
		expect(s.saved).toEqual({ x: 2 });
		expect(s.error).toBeNull();
	});

	it('sends snapshots strictly in order, so a late answer cannot overwrite a later one', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		s.set({ x: 2 });
		const b = s.save();
		m.sets[0].resolve();
		await a;
		await flush();
		m.sets[1].resolve();
		await b;
		expect(m.sets.map((p) => p.args[1])).toEqual([raw(1), raw(2)]);
		expect(s.saved).toEqual({ x: 2 });
	});
});

describe('immediate mode', () => {
	it('sends after set() and coalesces a burst of sets', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { mode: 'immediate' }));
		s.set({ x: 1 });
		s.set({ x: 2 });
		s.set({ x: 3 });
		expect(m.sets).toHaveLength(1);
		m.sets[0].resolve();
		await flush();
		expect(m.sets).toHaveLength(2);
		expect(m.sets[1].args[1]).toBe(raw(3));
		m.sets[1].resolve();
		await flush();
		expect(s.saved).toEqual({ x: 3 });
		expect(s.dirty).toBe(false);
	});

	it('does not send a set that equals the saved value', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { mode: 'immediate' }));
		s.set({ x: 1 });
		m.sets[0].resolve();
		await flush();
		s.set({ x: 1 });
		expect(m.sets).toHaveLength(1);
	});

	it('explicit mode never sends on set()', () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		expect(m.sets).toHaveLength(0);
	});
});

describe('load', () => {
	it('applies a stored value to current and saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		expect(s.loading).toBe(true);
		m.gets[0].resolve(raw(7));
		expect(await done).toBe('loaded');
		expect(s.current).toEqual({ x: 7 });
		expect(s.saved).toEqual({ x: 7 });
		expect(s.dirty).toBe(false);
		expect(s.loading).toBe(false);
	});

	it('missing: current is the fallback, saved stays undefined', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		m.gets[0].resolve(null);
		expect(await done).toBe('missing');
		expect(s.current).toEqual({ x: 0 });
		expect(s.saved).toBeUndefined();
		expect(s.dirty).toBe(false);
	});

	it.each([
		['broken JSON', '{nope'],
		['unknown version', JSON.stringify({ v: 99, x: 3 })],
		['wrong shape', JSON.stringify({ v: 1, x: 'a' })]
	])('invalid (%s): falls back to the default and reports invalid', async (_name, stored) => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { fallback: () => ({ x: 42 }) }));
		const done = s.load();
		m.gets[0].resolve(stored);
		expect(await done).toBe('invalid');
		expect(s.current).toEqual({ x: 42 });
		expect(s.saved).toBeUndefined();
		expect(s.error).toBeNull();
		// an explicit save can overwrite the broken stored value even though not dirty
		const saved = s.save();
		expect(m.sets[0].args[1]).toBe(raw(42));
		m.sets[0].resolve();
		expect(await saved).toBe(true);
		expect(s.saved).toEqual({ x: 42 });
	});

	it('provider failure: failed, current and saved untouched, error set', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 9 });
		const done = s.load();
		const failure = new ProviderError({ kind: 'unauthorized' });
		m.gets[0].reject(failure);
		expect(await done).toBe('failed');
		expect(s.error).toBe(failure);
		expect(s.current).toEqual({ x: 9 });
		expect(s.saved).toBeUndefined();
	});

	it('does not overwrite an edit made while loading, but records the stored value as saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		s.set({ x: 5 });
		m.gets[0].resolve(raw(7));
		expect(await done).toBe('loaded');
		expect(s.current).toEqual({ x: 5 });
		expect(s.saved).toEqual({ x: 7 });
		expect(s.dirty).toBe(true);
	});

	it('a stale load (answers swapped) is dropped; the newer load wins', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const first = s.load();
		const second = s.load();
		m.gets[1].resolve(raw(2)); // newer answers first
		expect(await second).toBe('loaded');
		m.gets[0].resolve(raw(1)); // older answers late
		expect(await first).toBe('stale');
		expect(s.current).toEqual({ x: 2 });
		expect(s.saved).toEqual({ x: 2 });
	});

	it('a load that raced with a save is dropped', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const load = s.load();
		s.set({ x: 3 });
		const save = s.save();
		m.gets[0].resolve(raw(1)); // read before the write landed
		expect(await load).toBe('stale');
		m.sets[0].resolve();
		await save;
		expect(s.saved).toEqual({ x: 3 });
		expect(s.current).toEqual({ x: 3 });
	});

	it('a stale load failure does not set error', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const first = s.load();
		const second = s.load();
		m.gets[1].resolve(raw(2));
		await second;
		m.gets[0].reject(new Error('late'));
		expect(await first).toBe('stale');
		expect(s.error).toBeNull();
	});
});

describe('revert / resetToDefault', () => {
	it('distinguishes returning to the saved value from the standard value', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { fallback: () => ({ x: 100 }) }));
		s.set({ x: 1 });
		const done = s.save();
		m.sets[0].resolve();
		await done;
		s.set({ x: 2 });
		s.revert();
		expect(s.current).toEqual({ x: 1 });
		expect(s.dirty).toBe(false);
		s.resetToDefault();
		expect(s.current).toEqual({ x: 100 });
		expect(s.saved).toEqual({ x: 1 }); // nothing is saved by either
		expect(s.dirty).toBe(true);
		expect(m.sets).toHaveLength(1);
	});

	it('revert with nothing saved goes to the standard value', () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { fallback: () => ({ x: 100 }) }));
		s.set({ x: 1 });
		s.revert();
		expect(s.current).toEqual({ x: 100 });
		expect(s.dirty).toBe(false);
	});
});

describe('dispose', () => {
	it('ignores the answer in flight and resolves the queue as false', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		const b = s.save();
		s.dispose();
		m.sets[0].resolve();
		expect(await a).toBe(false);
		expect(await b).toBe(false);
		expect(s.saved).toBeUndefined();
		expect(m.sets).toHaveLength(1);
		expect(await s.save()).toBe(false);
		expect(await s.load()).toBe('stale');
		expect(m.gets).toHaveLength(0);
	});

	it('drops a load in flight', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		s.dispose();
		m.gets[0].resolve(raw(7));
		expect(await done).toBe('stale');
		expect(s.current).toEqual({ x: 0 });
	});
});

describe('re-entrancy from callbacks', () => {
	it('provider.set that calls set() and save() re-entrantly queues one follow-up and keeps state consistent', async () => {
		const sets: Pending<void>[] = [];
		const ref: { setting?: SavedSetting<Pos> } = {};
		let reentered: Promise<boolean> | undefined;
		const provider: UiSettingsProvider = {
			get: async () => null,
			set: (key, value) =>
				new Promise((resolve, reject) => {
					sets.push({ args: [key, value], resolve, reject });
					if (sets.length === 1) {
						ref.setting?.set({ x: 2 });
						reentered = ref.setting?.save();
					}
				})
		};
		const s = createSavedSetting(options(provider));
		ref.setting = s;
		s.set({ x: 1 });
		const first = s.save();
		expect(sets).toHaveLength(1); // the re-entrant save did not start a second send
		expect(s.saving).toBe(true);
		sets[0].resolve();
		expect(await first).toBe(true);
		expect(s.saved).toEqual({ x: 1 }); // the sent snapshot, not the re-entrant edit
		await flush();
		expect(sets).toHaveLength(2);
		expect(sets[1].args[1]).toBe(raw(2));
		sets[1].resolve();
		expect(await reentered).toBe(true);
		expect(s.saved).toEqual({ x: 2 });
		expect(s.dirty).toBe(false);
	});

	it('parse that edits the setting during load does not get its edit overwritten', async () => {
		const m = manualProvider();
		const ref: { setting?: SavedSetting<Pos> } = {};
		const s = createSavedSetting(
			options(m.provider, {
				parse: (stored) => {
					ref.setting?.set({ x: 50 });
					return { x: Number(stored) };
				}
			})
		);
		ref.setting = s;
		const done = s.load();
		m.gets[0].resolve('7');
		expect(await done).toBe('loaded');
		expect(s.current).toEqual({ x: 50 });
		expect(s.saved).toEqual({ x: 7 });
		expect(s.dirty).toBe(true);
	});

	it('fallback that disposes during load leaves nothing applied', async () => {
		const m = manualProvider();
		let calls = 0;
		const ref: { setting?: SavedSetting<Pos> } = {};
		const s = createSavedSetting(
			options(m.provider, {
				fallback: () => {
					if (++calls > 1) ref.setting?.dispose();
					return { x: 0 };
				}
			})
		);
		ref.setting = s;
		const done = s.load();
		m.gets[0].resolve(null);
		expect(await done).toBe('stale');
		expect(s.saved).toBeUndefined();
	});
});

describe('PR #442 review', () => {
	it('saved is an independent copy of what was sent, even if the caller mutates its object meanwhile', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const value = { x: 1 };
		s.set(value);
		const done = s.save();
		value.x = 99; // the caller mutates its own object while the send is pending
		m.sets[0].resolve();
		expect(await done).toBe(true);
		expect(m.sets[0].args[1]).toBe(raw(1));
		expect(s.saved).toEqual({ x: 1 });
		expect(s.saved).not.toBe(value);
	});

	it('a load started while a save is in flight is stale and does not roll current back', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 5 });
		const saving = s.save();
		expect(await s.load()).toBe('stale');
		expect(m.gets).toHaveLength(0); // it does not even read
		m.sets[0].resolve();
		expect(await saving).toBe(true);
		expect(s.current).toEqual({ x: 5 });
		expect(s.saved).toEqual({ x: 5 });
		expect(s.dirty).toBe(false);
	});
});

describe('PR #442 re-review', () => {
	it('after revert, editing current in place does not change saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const first = s.save();
		m.sets[0].resolve();
		expect(await first).toBe(true);
		s.revert();
		const v = s.current as Pos;
		v.x = 2;
		s.set(v);
		const second = s.save();
		m.sets[1].reject(new Error('offline'));
		expect(await second).toBe(false);
		expect(s.saved).toEqual({ x: 1 });
		s.revert();
		expect(s.current).toEqual({ x: 1 });
		expect(s.dirty).toBe(false);
	});

	it('after load, editing current in place does not change saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const loading = s.load();
		m.gets[0].resolve(raw(1));
		expect(await loading).toBe('loaded');
		const v = s.current as Pos;
		v.x = 7;
		expect(s.saved).toEqual({ x: 1 });
		expect(s.current).not.toBe(s.saved);
	});

	it('a parse that disposes during the success copy keeps the save from committing', async () => {
		const m = manualProvider();
		const ref: { s: SavedSetting<Pos> | null; armed: boolean } = { s: null, armed: false };
		const base = options(m.provider);
		const s = createSavedSetting({
			...base,
			parse: (text: string) => {
				if (ref.armed) ref.s?.dispose();
				return base.parse(text);
			}
		});
		ref.s = s;
		s.set({ x: 3 });
		const done = s.save();
		ref.armed = true;
		m.sets[0].resolve();
		expect(await done).toBe(false);
		expect(s.saved).toBeUndefined();
	});
});
