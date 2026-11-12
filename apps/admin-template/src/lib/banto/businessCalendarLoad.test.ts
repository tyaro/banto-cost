import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ httpRequest: vi.fn() }));
vi.mock('./pipelineAdmin', () => ({
	isPipelineAvailable: () => true,
	demoModeError: () => new Error('demo'),
	httpRequest: mocks.httpRequest,
	invokeCommand: vi.fn()
}));
vi.mock('./setup', () => ({ getBantoMode: () => 'http' }));

import {
	businessCalendar,
	loadBusinessCalendar,
	setBusinessCalendarForTest
} from './businessCalendar.svelte';

afterEach(() => {
	vi.useRealTimers();
	setBusinessCalendarForTest(null);
	mocks.httpRequest.mockReset();
});

describe('loadBusinessCalendar', () => {
	it('does not hold up navigation when the request stalls, and uses it once it arrives', async () => {
		vi.useFakeTimers();
		let answer: (value: unknown) => void = () => {};
		mocks.httpRequest.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const wait = loadBusinessCalendar(3000);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(wait).resolves.toBeUndefined();
		expect(businessCalendar()).toBeNull();
		answer({ today: '2026-11-13', nowMs: Date.now(), utcOffsetMinutes: 540 });
		await vi.advanceTimersByTimeAsync(0);
		expect(businessCalendar()?.today).toBe('2026-11-13');
	});

	it('falls back without a calendar when the request fails', async () => {
		mocks.httpRequest.mockRejectedValue(new Error('offline'));
		await loadBusinessCalendar();
		expect(businessCalendar()).toBeNull();
	});
});
