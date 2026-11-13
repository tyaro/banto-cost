import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ httpRequest: vi.fn(), generation: 1 }));
vi.mock('./pipelineAdmin', () => ({
	isPipelineAvailable: () => true,
	demoModeError: () => new Error('demo'),
	httpRequest: mocks.httpRequest,
	invokeCommand: vi.fn()
}));
vi.mock('./setup', () => ({ getBantoMode: () => 'http' }));
vi.mock('@banto/admin-core', () => ({
	getSessionController: () => ({ snapshot: { generation: mocks.generation } })
}));

import {
	loadMyAuthz,
	myAuthz,
	myCapabilities,
	reloadMyAuthz,
	setMyAuthzForTest
} from './myAuthz.svelte';

afterEach(() => {
	vi.useRealTimers();
	setMyAuthzForTest(null);
	mocks.httpRequest.mockReset();
	mocks.generation = 1;
});

const worker = { capabilities: ['time.entry'], memberships: [] };

describe('myAuthz (review D-4, §8-15)', () => {
	it('reads /api/authz/me once per session generation', async () => {
		mocks.httpRequest.mockResolvedValue(worker);
		await loadMyAuthz(1);
		await loadMyAuthz(1);
		expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
		expect(mocks.httpRequest).toHaveBeenCalledWith('/api/authz/me', { method: 'GET' });
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry']);
	});

	it("does not show another session's grants", async () => {
		mocks.httpRequest.mockResolvedValue(worker);
		await loadMyAuthz(1);
		mocks.generation = 2;
		expect(myAuthz()).toBeNull();
		expect(myCapabilities()).toBeNull();
	});

	it('drops an answer that arrives after the session changed', async () => {
		let answer: (value: unknown) => void = () => {};
		mocks.httpRequest.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const wait = loadMyAuthz(1);
		mocks.generation = 2;
		answer(worker);
		await wait;
		expect(myAuthz()).toBeNull();
	});

	it('is unknown when the read fails, and does not hold up navigation when it stalls', async () => {
		mocks.httpRequest.mockRejectedValue(new Error('offline'));
		await loadMyAuthz(1);
		expect(myCapabilities()).toBeNull();

		vi.useFakeTimers();
		mocks.httpRequest.mockReturnValue(new Promise(() => {}));
		const wait = loadMyAuthz(1, 3000);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(wait).resolves.toBeUndefined();
		expect(myCapabilities()).toBeNull();
	});

	it('gives up a read that stalls: the next load asks again and the late answer is dropped', async () => {
		vi.useFakeTimers();
		let late: (value: unknown) => void = () => {};
		mocks.httpRequest.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
		const first = loadMyAuthz(1, 3000);
		await vi.advanceTimersByTimeAsync(3000);
		await first;
		mocks.httpRequest.mockResolvedValueOnce(worker);
		await loadMyAuthz(1, 3000);
		expect(mocks.httpRequest).toHaveBeenCalledTimes(2);
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry']);
		late({ capabilities: ['amount.view'], memberships: [] });
		await vi.advanceTimersByTimeAsync(0);
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry']);
	});

	it('reload keeps the held grants until the new ones arrive', async () => {
		mocks.httpRequest.mockResolvedValueOnce(worker);
		await loadMyAuthz(1);
		let answer: (value: unknown) => void = () => {};
		mocks.httpRequest.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const wait = reloadMyAuthz();
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry']);
		answer({ capabilities: ['time.entry', 'amount.view'], memberships: [] });
		await wait;
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry', 'amount.view']);
	});

	it('a reload that fails is tried again on the next load, keeping the held grants meanwhile', async () => {
		mocks.httpRequest.mockResolvedValueOnce(worker);
		await loadMyAuthz(1);
		mocks.httpRequest.mockRejectedValueOnce(new Error('offline'));
		await reloadMyAuthz();
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry']);
		mocks.httpRequest.mockResolvedValueOnce({
			capabilities: ['time.entry', 'amount.view'],
			memberships: []
		});
		await loadMyAuthz(1);
		expect(mocks.httpRequest).toHaveBeenCalledTimes(3);
		expect([...(myCapabilities() ?? [])]).toEqual(['time.entry', 'amount.view']);
		await loadMyAuthz(1);
		expect(mocks.httpRequest).toHaveBeenCalledTimes(3);
	});

	it("drops the previous session's grants when the next session's read starts, even if it fails", async () => {
		mocks.httpRequest.mockResolvedValueOnce(worker);
		await loadMyAuthz(1);
		mocks.httpRequest.mockRejectedValueOnce(new Error('offline'));
		await loadMyAuthz(2);
		// Whatever generation is read now, nothing of session 1 is held.
		expect(myAuthz()).toBeNull();
		mocks.generation = 2;
		expect(myCapabilities()).toBeNull();
	});
});
