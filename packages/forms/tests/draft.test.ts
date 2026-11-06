/**
 * `FormDraft` / `draftSourceFrom` (shared-primitives-upstream-plan §3.5, Issue #432):
 * raw text, commit, the conditions of `markApplied`, discard, and the
 * "snapshot at the START of the apply becomes the baseline" contract.
 */
import { describe, expect, it } from 'vitest';
import { createFormDraft, draftSourceFrom } from '../src/draft.svelte';
import type { FormSchema } from '../src/types';

const schema: FormSchema = {
	fields: [
		{ name: 'title', label: 'Title', type: 'text', required: true },
		{ name: 'qty', label: 'Qty', type: 'number', min: 0, max: 10 },
		{ name: 'tags', label: 'Tags', type: 'text' }
	]
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => (resolve = res));
	return { promise, resolve };
}

const make = (initial: Record<string, unknown> = { title: 'committed', qty: 1 }) =>
	createFormDraft({ key: 'memo', schema, initial, messages: { notANumber: () => 'NaN!' } });

describe('FormDraft raw text and commit', () => {
	it('keeps incomplete / invalid number text as raw without touching values', () => {
		const draft = make();
		draft.setRaw('qty', '1e');
		expect(draft.raw).toEqual({ qty: '1e' });
		expect(draft.values.qty).toBe(1);
		expect(draft.dirty).toBe(true);
		expect(draft.commit('qty')).toBe(false);
		expect(draft.errors.qty).toBe('NaN!');
		expect(draft.raw.qty).toBe('1e');
		expect(draft.values.qty).toBe(1);
	});

	it('commit parses, validates and moves the value in; the raw text is dropped', () => {
		const draft = make();
		const before = draft.revision;
		draft.setRaw('qty', ' 7 ');
		expect(draft.revision).toBe(before + 1);
		expect(draft.commit('qty')).toBe(true);
		expect(draft.values.qty).toBe(7);
		expect(draft.raw).toEqual({});
		expect(draft.errors).toEqual({});
		expect(draft.revision).toBe(before + 2);
	});

	it('a parsed value that fails validation stays raw with the schema message', () => {
		const draft = make();
		draft.setRaw('qty', '11');
		expect(draft.commit('qty')).toBe(false);
		expect(draft.errors.qty).toBeTruthy();
		expect(draft.raw.qty).toBe('11');
		expect(draft.values.qty).toBe(1);
		draft.setRaw('qty', '');
		expect(draft.errors.qty).toBeUndefined();
		expect(draft.commit('qty')).toBe(true);
		expect(draft.values.qty).toBe('');
	});

	it('raw text equal to the committed value is not dirty', () => {
		const draft = make();
		draft.setRaw('qty', '1');
		expect(draft.dirty).toBe(false);
		draft.setRaw('qty', '12');
		expect(draft.dirty).toBe(true);
	});

	it('commitAll is all or nothing: a failing field keeps every raw field uncommitted and lists every error', () => {
		const draft = make({ title: '', qty: 1 });
		draft.setRaw('qty', '3');
		expect(draft.commitAll()).toBe(false);
		expect(draft.values.qty).toBe(1);
		expect(draft.raw.qty).toBe('3');
		expect(Object.keys(draft.errors)).toEqual(['title']);
		draft.setRaw('title', 'ok');
		expect(draft.commitAll()).toBe(true);
		expect(draft.values).toMatchObject({ title: 'ok', qty: 3 });
		expect(draft.raw).toEqual({});
	});

	it('commitAll validates against the final values of every field (cross-field validator, #447 review)', () => {
		const cross = createFormDraft({
			key: 'cross',
			schema: {
				fields: [
					{
						name: 'start',
						label: 'Start',
						type: 'number',
						validate: (v, values) => (Number(v) > Number(values.end) ? 'start > end' : null)
					},
					{ name: 'end', label: 'End', type: 'number' }
				]
			},
			initial: { start: 1, end: 10 }
		});
		// start 5 is fine against the OLD end (10) but not against the new end (3).
		cross.setRaw('start', '5');
		cross.setRaw('end', '3');
		expect(cross.commitAll()).toBe(false);
		expect(cross.errors.start).toBe('start > end');
		expect(cross.values).toEqual({ start: 1, end: 10 });
		cross.setRaw('start', '2');
		expect(cross.commitAll()).toBe(true);
		expect(cross.values).toEqual({ start: 2, end: 3 });
	});

	it('setValue sets directly and drops the raw text', () => {
		const draft = make();
		draft.setRaw('qty', 'x');
		draft.setValue('qty', 4);
		expect(draft.raw).toEqual({});
		expect(draft.values.qty).toBe(4);
	});
});

describe('FormDraft baseline is never shared with the edited values (#437 review)', () => {
	it('mutating values / the initial object / an applied snapshot in place does not move the baseline', () => {
		const initial = { title: 'a', qty: 1, tags: { list: ['x'] } };
		const draft = make(initial);
		initial.tags.list.push('from-initial');
		expect(draft.baseline.tags).toEqual({ list: ['x'] });
		expect(draft.values.tags).not.toBe(draft.baseline.tags);
		(draft.values.tags as { list: string[] }).list.push('in-place');
		expect(draft.baseline.tags).toEqual({ list: ['x'] });
		expect(draft.dirty).toBe(true);

		const snapshot = draft.snapshotForApply();
		expect(draft.markApplied(snapshot)).toBe(true);
		(snapshot.values.tags as { list: string[] }).list.push('after-apply');
		expect(draft.baseline.tags).toEqual({ list: ['x', 'in-place'] });
		expect(draft.dirty).toBe(false);
	});
});

describe('FormDraft markApplied conditions', () => {
	it('makes the snapshot the baseline only when called (after success)', () => {
		const draft = make();
		draft.setValue('title', 'v1');
		const snapshot = draft.snapshotForApply();
		expect(draft.baseline.title).toBe('committed');
		expect(draft.dirty).toBe(true);
		expect(draft.markApplied(snapshot)).toBe(true);
		expect(draft.baseline.title).toBe('v1');
		expect(draft.dirty).toBe(false);
	});

	it('ignores a snapshot older than the baseline (a slower earlier apply finishing last)', () => {
		const draft = make();
		draft.setValue('title', 'v1');
		const first = draft.snapshotForApply();
		draft.setValue('title', 'v2');
		const second = draft.snapshotForApply();
		expect(draft.markApplied(second)).toBe(true);
		expect(draft.markApplied(first)).toBe(false);
		expect(draft.baseline.title).toBe('v2');
		expect(draft.dirty).toBe(false);
	});

	it('ignores a snapshot this draft never issued (revision ahead of it)', () => {
		const draft = make();
		expect(draft.markApplied({ values: { title: 'x' }, revision: draft.revision + 5 })).toBe(false);
		expect(draft.baseline.title).toBe('committed');
	});

	it('input made during a delayed apply stays dirty after the apply succeeds', async () => {
		const draft = make();
		const gate = deferred<boolean>();
		const sent: Record<string, unknown>[] = [];
		const source = draftSourceFrom(draft, (values) => {
			sent.push(values);
			return gate.promise;
		});
		draft.setValue('title', 'v1');
		const applying = source.apply();
		draft.setRaw('title', 'v2'); // typed while the apply is awaited
		gate.resolve(true);
		expect(await applying).toBe(true);
		expect(sent).toEqual([{ title: 'v1', qty: 1, tags: '' }]);
		expect(draft.baseline.title).toBe('v1');
		expect(draft.raw.title).toBe('v2');
		expect(draft.dirty).toBe(true);
		expect(source.isDirty()).toBe(true);
	});

	it('a failed apply keeps the baseline and the input', async () => {
		const draft = make();
		const source = draftSourceFrom(draft, async () => false);
		draft.setValue('title', 'v1');
		expect(await source.apply()).toBe(false);
		expect(draft.baseline.title).toBe('committed');
		expect(draft.dirty).toBe(true);
	});

	it('a validation failure does not call apply and keeps everything', async () => {
		const draft = make();
		let called = false;
		const source = draftSourceFrom(draft, async () => (called = true));
		draft.setRaw('qty', 'abc');
		expect(await source.apply()).toBe(false);
		expect(called).toBe(false);
		expect(draft.raw.qty).toBe('abc');
	});

	it('the values handed to apply are a separate copy (mutating them does not move the baseline)', async () => {
		const draft = make({ title: 'a', qty: 1, tags: { list: [] } });
		draft.setValue('title', 'b');
		const source = draftSourceFrom(draft, async (values) => {
			(values.tags as { list: string[] }).list.push('consumer');
			values.title = 'mutated';
			return true;
		});
		expect(await source.apply()).toBe(true);
		expect(draft.baseline).toEqual({ title: 'b', qty: 1, tags: { list: [] } });
		expect(draft.dirty).toBe(false);
	});
});

describe('FormDraft discard', () => {
	it('returns to (a copy of) the baseline and clears raw text and errors', () => {
		const draft = make();
		draft.setValue('title', 'changed');
		draft.setRaw('qty', 'bad');
		draft.commit('qty');
		const before = draft.revision;
		draft.discard();
		expect(draft.values).toEqual(draft.baseline);
		expect(draft.values).not.toBe(draft.baseline);
		expect(draft.raw).toEqual({});
		expect(draft.errors).toEqual({});
		expect(draft.dirty).toBe(false);
		expect(draft.revision).toBe(before + 1);
	});
});
