/**
 * banto-cost（1人で使う）: `auth_sole_user` はデスクトップ版でだけ聞き、
 * 失敗やブラウザでは false（ログアウトを出す側）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ tauri: true }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./environment', () => ({ isTauri: () => env.tauri }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { refreshSoleUser, soleUserStore } from './soleUser.svelte';

describe('soleUserStore', () => {
	beforeEach(() => {
		invoke.mockReset();
		env.tauri = true;
	});

	it('follows auth_sole_user on the desktop app', async () => {
		invoke.mockResolvedValue(true);
		await refreshSoleUser();
		expect(invoke).toHaveBeenCalledWith('auth_sole_user');
		expect(soleUserStore.active).toBe(true);

		invoke.mockResolvedValue(false);
		await refreshSoleUser();
		expect(soleUserStore.active).toBe(false);
	});

	it('is false when the command fails', async () => {
		invoke.mockResolvedValue(true);
		await refreshSoleUser();
		invoke.mockRejectedValue(new Error('boom'));
		await refreshSoleUser();
		expect(soleUserStore.active).toBe(false);
	});

	it('is false outside the desktop app without asking', async () => {
		env.tauri = false;
		await refreshSoleUser();
		expect(invoke).not.toHaveBeenCalled();
		expect(soleUserStore.active).toBe(false);
	});

	it('keeps the newest answer when an older one arrives late', async () => {
		let resolveOld: (v: boolean) => void = () => {};
		invoke.mockReturnValueOnce(new Promise<boolean>((r) => (resolveOld = r)));
		invoke.mockResolvedValueOnce(false);
		const old = refreshSoleUser();
		await refreshSoleUser();
		resolveOld(true);
		await old;
		expect(soleUserStore.active).toBe(false);
	});
});
