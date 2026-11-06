import { describe, expect, it, vi } from 'vitest';
import { REACH_CHECK_PATH, parseReachToken, postReachCheck, takeReachToken } from './reach';

const TOKEN = '0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f';

function fakeLocation(hash: string) {
	return { hash, pathname: '/reach', search: '' };
}

function fakeHistory() {
	return { state: { 'sveltekit:index': 1 }, replaceState: vi.fn() };
}

describe('parseReachToken', () => {
	it('reads a uuid token from #t=', () => {
		expect(parseReachToken(`#t=${TOKEN}`)).toBe(TOKEN);
		expect(parseReachToken(`#t=${TOKEN.toUpperCase()}`)).toBe(TOKEN.toUpperCase());
	});

	it('refuses a missing or malformed token', () => {
		expect(parseReachToken('')).toBeNull();
		expect(parseReachToken('#')).toBeNull();
		expect(parseReachToken('#x=1')).toBeNull();
		expect(parseReachToken('#t=')).toBeNull();
		expect(parseReachToken('#t=not-a-token')).toBeNull();
		expect(parseReachToken(`#t=${TOKEN}0`)).toBeNull();
	});
});

describe('takeReachToken', () => {
	it('removes the fragment with replaceState (keeping the router state) and returns the token', () => {
		const history = fakeHistory();
		expect(takeReachToken(fakeLocation(`#t=${TOKEN}`), history)).toBe(TOKEN);
		expect(history.replaceState).toHaveBeenCalledWith({ 'sveltekit:index': 1 }, '', '/reach');
	});

	it('removes a malformed fragment too, and returns null', () => {
		const history = fakeHistory();
		expect(takeReachToken(fakeLocation('#t=bad'), history)).toBeNull();
		expect(history.replaceState).toHaveBeenCalledTimes(1);
	});

	it('does nothing without a fragment', () => {
		const history = fakeHistory();
		expect(takeReachToken(fakeLocation(''), history)).toBeNull();
		expect(history.replaceState).not.toHaveBeenCalled();
	});
});

function respond(status: number, body: unknown) {
	return vi.fn(() =>
		Promise.resolve(
			new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' }
			})
		)
	);
}

describe('postReachCheck', () => {
	it('POSTs the token with the CSRF header and no credentials', async () => {
		const fetchFn = respond(200, { result: 'recorded' });
		expect(await postReachCheck(TOKEN, fetchFn as unknown as typeof fetch)).toBe('recorded');
		const [path, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(path).toBe(REACH_CHECK_PATH);
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({
			'X-Banto-Client': 'banto',
			'Content-Type': 'application/json'
		});
		expect(init.headers).not.toHaveProperty('Authorization');
		expect(init.credentials).toBe('omit');
		expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
	});

	it.each([
		[200, 'selfAccess'],
		[404, 'unusable'],
		[403, 'unusable'],
		[409, 'hostMismatch'],
		[429, 'rateLimited']
	] as const)('maps %i { result: %s }', async (status, result) => {
		const fetchFn = respond(status, { result });
		expect(await postReachCheck(TOKEN, fetchFn as unknown as typeof fetch)).toBe(result);
	});

	it('is failed for an unknown code, a non-JSON body or a network error', async () => {
		expect(
			await postReachCheck(TOKEN, respond(200, { result: 'other' }) as unknown as typeof fetch)
		).toBe('failed');
		expect(await postReachCheck(TOKEN, respond(403, 'Forbidden') as unknown as typeof fetch)).toBe(
			'failed'
		);
		const offline = vi.fn(() => Promise.reject(new TypeError('offline')));
		expect(await postReachCheck(TOKEN, offline as unknown as typeof fetch)).toBe('failed');
	});
});
