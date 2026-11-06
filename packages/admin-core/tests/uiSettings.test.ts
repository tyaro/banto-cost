import { describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import {
	createHttpUiSettings,
	createLocalUiSettings,
	createTauriUiSettings
} from '../src/providers/uiSettings';

/** In-memory Storage stand-in: Node has no global localStorage (same helper as http.test.ts). */
function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		}
	} as Storage;
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { 'content-type': 'application/json' }
	});
}

describe('createLocalUiSettings', () => {
	it('get resolves null for a key that was never set', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await expect(provider.get('theme.mode')).resolves.toBeNull();
	});

	it('set then get round-trips the value', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await provider.set('theme.mode', 'dark');
		await expect(provider.get('theme.mode')).resolves.toBe('dark');
	});

	it('stores under the banto.ui. prefix so app keys never collide', async () => {
		const storage = makeMemoryStorage();
		const provider = createLocalUiSettings({ storage });
		await provider.set('dock.dashboard', '{"version":2}');
		expect(storage.getItem('banto.ui.dock.dashboard')).toBe('{"version":2}');
	});

	it('rejects a key outside [A-Za-z0-9._-]{1,64} with a ProviderError', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await expect(provider.get('bad key!')).rejects.toSatisfy(isProviderError);
		await expect(provider.set('a'.repeat(65), 'v')).rejects.toSatisfy(isProviderError);
	});
});

describe('createTauriUiSettings', () => {
	it('get calls ui_settings_get with { key } and returns the stored string', async () => {
		const invoke = vi.fn().mockResolvedValue('glass');
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.get('theme.preset')).resolves.toBe('glass');
		expect(invoke).toHaveBeenCalledWith('ui_settings_get', { key: 'theme.preset' });
	});

	it('get maps an unset key (null result) to null', async () => {
		const invoke = vi.fn().mockResolvedValue(null);
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.get('theme.preset')).resolves.toBeNull();
	});

	it('set calls ui_settings_set with { key, value }', async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		const provider = createTauriUiSettings({ invoke });

		await provider.set('theme.mode', 'dark');

		expect(invoke).toHaveBeenCalledWith('ui_settings_set', { key: 'theme.mode', value: 'dark' });
	});

	it('rethrows a rejected invoke() carrying an ErrorBody as a ProviderError', async () => {
		const invoke = vi.fn().mockRejectedValue({ kind: 'unauthorized' });
		const provider = createTauriUiSettings({ invoke });

		try {
			await provider.get('theme.mode');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'unauthorized' });
		}
	});

	it('rejects an invalid key locally without calling invoke', async () => {
		const invoke = vi.fn();
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.set('のテーマ', 'x')).rejects.toSatisfy(isProviderError);
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe('createHttpUiSettings', () => {
	it('get GETs {base}/api/ui-settings/{key} with CSRF + bearer headers and returns body.value', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: 'dark' }));
		const provider = createHttpUiSettings({
			baseUrl: 'http://h:8721',
			getToken: () => 'tok',
			fetchFn
		});

		await expect(provider.get('theme.mode')).resolves.toBe('dark');
		expect(fetchFn).toHaveBeenCalledWith('http://h:8721/api/ui-settings/theme.mode', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' }
		});
	});

	it('get maps {"value": null} (unset key) to null', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: null }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.get('theme.preset')).resolves.toBeNull();
	});

	it('set PUTs {base}/api/ui-settings/{key} with a {"value"} body and resolves on 204', async () => {
		const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.set('theme.preset', 'glass')).resolves.toBeUndefined();
		expect(fetchFn).toHaveBeenCalledWith('/api/ui-settings/theme.preset', {
			method: 'PUT',
			headers: {
				'X-Banto-Client': 'banto',
				'Content-Type': 'application/json',
				Authorization: 'Bearer tok'
			},
			body: JSON.stringify({ value: 'glass' })
		});
	});

	it('omits Authorization when getToken() returns null', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: null }));
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await provider.get('theme.mode');

		const [, init] = fetchFn.mock.calls[0];
		expect(init.headers.Authorization).toBeUndefined();
	});

	it('maps a non-2xx ErrorBody JSON response to a matching ProviderError', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, { kind: 'unauthorized' }));
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		try {
			await provider.get('theme.mode');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'unauthorized' });
		}
	});

	it('maps a network failure to kind "other" with a Japanese message', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		try {
			await provider.set('theme.mode', 'dark');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err))
				expect(err.body).toEqual({ kind: 'other', message: 'サーバーに接続できません' });
		}
	});

	it('rejects an invalid key locally without calling fetch (it would otherwise mangle the URL)', async () => {
		const fetchFn = vi.fn();
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await expect(provider.get('a/b')).rejects.toSatisfy(isProviderError);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
