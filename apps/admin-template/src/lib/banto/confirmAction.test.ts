/**
 * The confirmation of an operation that is hard to take back
 * (confirmAction.svelte.ts, review D-5 / §8-8): one question at a time, every
 * way out that is not "proceed" is false, and without a mounted dialog the
 * same text goes to window.confirm.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmAction, confirmState, confirmText } from './confirmAction.svelte';

const request = {
	title: '受注転換',
	body: '案件を受注済みに切り替えます。',
	details: [
		{ label: '案件', value: 'P-001' },
		{ label: '確定受注額', value: '¥2,800,000' }
	],
	undo: '理由をつけて取り消せます。',
	confirmLabel: '受注転換する'
};

afterEach(() => {
	vi.unstubAllGlobals();
	confirmState.answer(false);
});

describe('confirmAction', () => {
	it('opens the mounted dialog and resolves with the answer', async () => {
		const detach = confirmState.attach();
		const answer = confirmAction(request);
		expect(confirmState.request).toEqual(request);
		confirmState.answer(true);
		await expect(answer).resolves.toBe(true);
		expect(confirmState.request).toBeNull();
		detach();
	});

	it('a new question answers the open one false, and unmounting answers false', async () => {
		const detach = confirmState.attach();
		const first = confirmAction(request);
		const second = confirmAction({ ...request, title: '月次締め' });
		await expect(first).resolves.toBe(false);
		expect(confirmState.request?.title).toBe('月次締め');
		detach();
		await expect(second).resolves.toBe(false);
		expect(confirmState.hosted).toBe(false);
	});

	it('falls back to window.confirm with the details and the undo line', async () => {
		const confirm = vi.fn(() => true);
		vi.stubGlobal('window', { confirm });
		await expect(confirmAction(request)).resolves.toBe(true);
		expect(confirm).toHaveBeenCalledWith(confirmText(request));
		expect(confirmText(request)).toBe(
			'受注転換\n案件を受注済みに切り替えます。\n案件: P-001\n確定受注額: ¥2,800,000\n理由をつけて取り消せます。'
		);
	});
});
