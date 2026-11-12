import { describe, expect, it } from 'vitest';
import { ProviderError } from '@banto/admin-core';
import { failureReason, runEach } from './bulk.js';

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

describe('failureReason', () => {
	it('gives a validation refusal its field messages', () => {
		const err = new ProviderError({
			kind: 'validation',
			field_errors: [
				{ field: 'workDate', message: '2026年11月は締め済みです' },
				{ field: 'projectId', message: '精算完了の案件です' }
			]
		});
		expect(failureReason(err, '権限なし')).toBe('2026年11月は締め済みです / 精算完了の案件です');
	});

	it("uses the screen's wording for forbidden and the message otherwise", () => {
		expect(failureReason(new ProviderError({ kind: 'forbidden' }), '権限なし')).toBe('権限なし');
		expect(failureReason(new ProviderError({ kind: 'other', message: '競合' }), 'x')).toBe('競合');
		expect(failureReason(new Error('boom'), 'x')).toBe('Error: boom');
	});
});
