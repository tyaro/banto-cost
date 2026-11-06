/**
 * The settle dialog's state (settlePrompt.svelte.ts, Issue #432 PR-10):
 * one question at a time, and every way out that is not a choice is 'cancel'.
 */
import { describe, expect, it } from 'vitest';
import { createSettlePrompt } from './settlePrompt.svelte';

describe('createSettlePrompt', () => {
	it('ask opens the question and the answer closes it', async () => {
		const prompt = createSettlePrompt();
		expect(prompt.open).toBe(false);
		const answer = prompt.ask(['memo']);
		expect(prompt.open).toBe(true);
		expect(prompt.dirtyKeys).toEqual(['memo']);
		prompt.answer('discard');
		await expect(answer).resolves.toBe('discard');
		expect(prompt.open).toBe(false);
		expect(prompt.dirtyKeys).toEqual([]);
	});

	it('a new question answers the open one cancel', async () => {
		const prompt = createSettlePrompt();
		const first = prompt.ask(['a']);
		const second = prompt.ask(['b']);
		await expect(first).resolves.toBe('cancel');
		expect(prompt.dirtyKeys).toEqual(['b']);
		prompt.answer('apply');
		await expect(second).resolves.toBe('apply');
	});

	it('a second answer is ignored', async () => {
		const prompt = createSettlePrompt();
		const answer = prompt.ask(['memo']);
		prompt.answer('apply');
		prompt.answer('cancel');
		await expect(answer).resolves.toBe('apply');
	});

	it('dispose answers an open question cancel and later questions at once', async () => {
		const prompt = createSettlePrompt();
		const open = prompt.ask(['memo']);
		prompt.dispose();
		await expect(open).resolves.toBe('cancel');
		await expect(prompt.ask(['memo'])).resolves.toBe('cancel');
		expect(prompt.open).toBe(false);
	});
});
