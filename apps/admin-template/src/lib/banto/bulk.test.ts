import { describe, expect, it } from 'vitest';
import { runEach } from './bulk.js';

describe('runEach', () => {
	it('runs the rows in order and keeps going past a refusal', async () => {
		const seen: number[] = [];
		const result = await runEach([1, 2, 3, 4], async (n) => {
			seen.push(n);
			if (n % 2 === 0) throw new Error(`refused ${n}`);
		});
		expect(seen).toEqual([1, 2, 3, 4]);
		expect(result.done).toBe(2);
		expect(result.failed).toBe(2);
		expect((result.firstError as Error).message).toBe('refused 2');
	});

	it('reports nothing for no rows', async () => {
		expect(await runEach([], async () => {})).toEqual({ done: 0, failed: 0, firstError: null });
	});
});
