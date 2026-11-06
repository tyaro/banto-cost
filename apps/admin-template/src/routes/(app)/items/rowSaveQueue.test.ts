import { describe, expect, it } from 'vitest';
import { createRowSaveQueue } from './rowSaveQueue';

// Issue #284 regression tests. Both ItemsClientGrid and ItemsServerGrid route
// their inline edits (onCellEdit) and range pastes (onRangePaste) through the
// single queue created in +page.svelte, so these cover both grid paths.

interface Row {
	id: number;
	name: string;
	price: number;
	stock: number;
}

const original: Row = { id: 1, name: 'original', price: 100, stock: 10 };

function compose(base: Row, changes: Record<string, unknown>): Record<string, unknown> {
	return { name: base.name, price: base.price, stock: base.stock, ...changes };
}

/** A fake provider whose responses are resolved/rejected by hand, in any order. */
function setup() {
	const server = new Map<number, Row>([
		[1, { ...original }],
		[2, { ...original, id: 2 }]
	]);
	const sent: Record<string, unknown>[] = [];
	const gates: { resolve: () => void; reject: (e: Error) => void }[] = [];
	const queue = createRowSaveQueue<Row>({
		compose,
		save: (rowId, values) => {
			sent.push(values);
			return new Promise<Row>((resolve, reject) => {
				gates.push({
					resolve: () => {
						const next = { ...server.get(rowId as number)!, ...values } as Row;
						server.set(rowId as number, next);
						resolve(next);
					},
					reject
				});
			});
		}
	});
	return { queue, server, sent, gates };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createRowSaveQueue', () => {
	it('keeps both columns when a second paste starts before the first save returns', async () => {
		const { queue, server, sent, gates } = setup();
		const a = queue.enqueue(1, original, { name: 'pasted-name' });
		const b = queue.enqueue(1, original, { stock: 99 }); // stale display row
		await tick();
		expect(sent).toHaveLength(1); // second is held back until the first lands
		gates[0].resolve();
		await a;
		await tick();
		expect(sent[1]).toEqual({ name: 'pasted-name', price: 100, stock: 99 });
		gates[1].resolve();
		await b;
		expect(server.get(1)).toMatchObject({ name: 'pasted-name', stock: 99 });
	});

	it('does not overwrite a pasted value with a stale row on a following inline edit', async () => {
		const { queue, sent, gates } = setup();
		const paste = queue.enqueue(1, original, { name: 'pasted', price: 5 });
		const inline = queue.enqueue(1, original, { stock: 1 });
		await tick();
		gates[0].resolve();
		await paste;
		await tick();
		gates[1].resolve();
		await inline;
		expect(sent[1]).toEqual({ name: 'pasted', price: 5, stock: 1 });
	});

	it('settles results in send order', async () => {
		const { queue, gates } = setup();
		const order: string[] = [];
		const a = queue.enqueue(1, original, { name: 'a' }).then(() => order.push('a'));
		const b = queue.enqueue(1, original, { stock: 2 }).then(() => order.push('b'));
		await tick();
		gates[0].resolve();
		await tick();
		gates[1].resolve();
		await Promise.all([a, b]);
		expect(order).toEqual(['a', 'b']);
	});

	it('reports a failure only to its own caller and bases later saves on confirmed values', async () => {
		const { queue, sent, gates } = setup();
		const failing = queue.enqueue(1, original, { name: 'will-fail' });
		const failed = failing.catch((e: Error) => e.message);
		const next = queue.enqueue(1, original, { stock: 7 });
		await tick();
		gates[0].reject(new Error('boom'));
		expect(await failed).toBe('boom');
		await tick();
		// The failed name must not leak into the following request.
		expect(sent[1]).toEqual({ name: 'original', price: 100, stock: 7 });
		gates[1].resolve();
		await expect(next).resolves.toMatchObject({ name: 'original', stock: 7 });
	});

	it('does not block other rows', async () => {
		const { queue, sent } = setup();
		void queue.enqueue(1, original, { name: 'x' });
		void queue.enqueue(2, { ...original, id: 2 }, { name: 'y' });
		await tick();
		expect(sent).toHaveLength(2);
	});

	it('drops confirmed state once drained so later edits use the current display row', async () => {
		const { queue, sent, gates } = setup();
		const first = queue.enqueue(1, original, { name: 'one' });
		await tick();
		gates[0].resolve();
		await first;
		await tick();
		const reloaded: Row = { id: 1, name: 'external', price: 1, stock: 1 };
		void queue.enqueue(1, reloaded, { stock: 3 });
		await tick();
		expect(sent[1]).toEqual({ name: 'external', price: 1, stock: 3 });
	});

	it('bases an edit started before a save drained on the currently displayed row (#284 review)', async () => {
		let display: Row = { ...original };
		const sent: Record<string, unknown>[] = [];
		const queue = createRowSaveQueue<Row>({
			compose,
			currentRow: () => display,
			save: async (_id, values) => {
				sent.push(values);
				return { ...display, ...values } as Row;
			}
		});
		// 1. paste A into name; meanwhile the user opens a stock edit, whose
		//    edit.row snapshot still has the OLD name.
		const staleSnapshot = { ...original };
		// 2. A completes, the grid publishes it to the display, the lane drains.
		display = await queue.enqueue(1, original, { name: 'pasted-name' });
		await tick();
		// 3. the stock edit is confirmed with the pre-A snapshot.
		await queue.enqueue(1, staleSnapshot, { stock: 99 });
		expect(sent[1]).toEqual({ name: 'pasted-name', price: 100, stock: 99 });
	});

	it('falls back to the enqueue-time row when currentRow has no such row', async () => {
		const sent: Record<string, unknown>[] = [];
		const queue = createRowSaveQueue<Row>({
			compose,
			currentRow: () => undefined,
			save: async (_id, values) => {
				sent.push(values);
				return { ...original, ...values } as Row;
			}
		});
		await queue.enqueue(1, original, { stock: 1 });
		expect(sent[0]).toEqual({ name: 'original', price: 100, stock: 1 });
	});
});
