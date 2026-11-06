/**
 * Issue #258: the command palette history is per user, with the same rules
 * as admin-core's `listViewState` (owner recorded on save, read only for the
 * same owner, ownerless scope off, stale scope cannot write).
 */
import { describe, expect, it } from 'vitest';
import {
	createSessionController,
	resolveSettled,
	type AuthProvider,
	type CredentialRevision,
	type Identity,
	type ResolvedAuth,
	type SessionScope
} from '@banto/admin-core';
import {
	RECENT_KEY,
	loadRecentCommandIds,
	recordRecentCommand,
	watchRecentCommandOwner
} from './recentCommands';

class FakeStorage implements Storage {
	private map = new Map<string, string>();
	get length(): number {
		return this.map.size;
	}
	clear(): void {
		this.map.clear();
	}
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.map.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
}

const scopeOf = (owner: string | null, generation = 1): SessionScope => ({ generation, owner });
const live = () => true;

describe('recent command history (per owner)', () => {
	it("A's history is invisible to B, and visible again once A is back", () => {
		const storage = new FakeStorage();
		const opts = { storage, isCurrent: live };
		recordRecentCommand(scopeOf('account:alice'), 'nav./items', opts);
		recordRecentCommand(scopeOf('account:alice'), 'nav./users', opts);
		expect(loadRecentCommandIds(scopeOf('account:alice'), opts)).toEqual([
			'nav./users',
			'nav./items'
		]);
		expect(loadRecentCommandIds(scopeOf('account:bob'), opts)).toEqual([]);
		// B reading does not erase A's entry...
		expect(loadRecentCommandIds(scopeOf('account:alice'), opts)).toEqual([
			'nav./users',
			'nav./items'
		]);
		// ...but B recording replaces it (one owner's entry at a time, like the list view state purge).
		recordRecentCommand(scopeOf('account:bob'), 'nav./settings', opts);
		expect(loadRecentCommandIds(scopeOf('account:bob'), opts)).toEqual(['nav./settings']);
		expect(loadRecentCommandIds(scopeOf('account:alice'), opts)).toEqual([]);
	});

	it('discards the old ownerless format on read', () => {
		const storage = new FakeStorage();
		storage.setItem(RECENT_KEY, JSON.stringify(['nav./items', 'nav./users']));
		expect(loadRecentCommandIds(scopeOf('account:alice'), { storage })).toEqual([]);
		expect(storage.getItem(RECENT_KEY)).toBeNull();
	});

	it('an ownerless scope neither reads nor writes', () => {
		const storage = new FakeStorage();
		const opts = { storage, isCurrent: live };
		recordRecentCommand(scopeOf('account:alice'), 'nav./items', opts);
		expect(loadRecentCommandIds(scopeOf(null), opts)).toEqual([]);
		recordRecentCommand(scopeOf(null), 'nav./users', opts);
		expect(loadRecentCommandIds(scopeOf('account:alice'), opts)).toEqual(['nav./items']);
	});

	it('public-viewer and local are owners like any other key', () => {
		const storage = new FakeStorage();
		const opts = { storage, isCurrent: live };
		recordRecentCommand(scopeOf('publicViewer'), 'nav./items', opts);
		expect(loadRecentCommandIds(scopeOf('publicViewer'), opts)).toEqual(['nav./items']);
		expect(loadRecentCommandIds(scopeOf('local'), opts)).toEqual([]);
	});

	it('a scope that is no longer the live session cannot write', () => {
		const storage = new FakeStorage();
		recordRecentCommand(scopeOf('account:alice'), 'nav./items', {
			storage,
			isCurrent: () => false
		});
		expect(storage.getItem(RECENT_KEY)).toBeNull();
	});

	it('moves a repeated id to the front and caps the list at 10', () => {
		const storage = new FakeStorage();
		const opts = { storage, isCurrent: live };
		const scope = scopeOf('account:alice');
		for (let i = 0; i < 12; i++) recordRecentCommand(scope, `c${i}`, opts);
		recordRecentCommand(scope, 'c5', opts);
		const ids = loadRecentCommandIds(scope, opts);
		expect(ids).toHaveLength(10);
		expect(ids[0]).toBe('c5');
	});

	it('no storage at all is a silent no-op', () => {
		expect(loadRecentCommandIds(scopeOf('account:alice'), { storage: null })).toEqual([]);
		expect(() =>
			recordRecentCommand(scopeOf('account:alice'), 'x', { storage: null, isCurrent: live })
		).not.toThrow();
	});
});

describe('watchRecentCommandOwner (hygiene)', () => {
	const ALICE: Identity = { id: 'alice', name: 'Alice' };

	function provider(answers: ResolvedAuth[]) {
		const rev = '1.0' as CredentialRevision;
		const auth: AuthProvider = {
			login: async () => ({ success: true }),
			logout: async () => {},
			resolve: async () => answers.shift() ?? { status: 'none', checked: rev, current: rev },
			credentialRevision: () => rev,
			onCredentialChanged: () => () => {}
		};
		return auth;
	}
	const active = (identity: Identity): ResolvedAuth => ({
		status: 'active',
		checked: '1.0' as CredentialRevision,
		current: '1.0' as CredentialRevision,
		identity,
		kind: 'account'
	});

	it("drops another owner's entry once an owner is confirmed, keeps the same owner's", async () => {
		const storage = new FakeStorage();
		const opts = { storage, isCurrent: live };
		recordRecentCommand(scopeOf('account:bob'), 'nav./items', opts);
		const controller = createSessionController(provider([active(ALICE)]), {
			onNone: () => {},
			onActive: () => {}
		});
		const stop = watchRecentCommandOwner(controller, opts);
		await resolveSettled(controller);
		expect(storage.getItem(RECENT_KEY)).toBeNull();
		stop();

		recordRecentCommand(scopeOf('account:alice'), 'nav./users', opts);
		const again = createSessionController(provider([active(ALICE)]), {
			onNone: () => {},
			onActive: () => {}
		});
		const stop2 = watchRecentCommandOwner(again, opts);
		await resolveSettled(again);
		expect(loadRecentCommandIds(scopeOf('account:alice'), opts)).toEqual(['nav./users']);
		stop2();
	});

	it('drops the history when none is confirmed', async () => {
		const storage = new FakeStorage();
		const opts = { storage, isCurrent: live };
		recordRecentCommand(scopeOf('account:alice'), 'nav./items', opts);
		const controller = createSessionController(provider([]), {
			onNone: () => {},
			onActive: () => {}
		});
		const stop = watchRecentCommandOwner(controller, opts);
		await resolveSettled(controller);
		expect(controller.snapshot.status).toBe('none');
		expect(storage.getItem(RECENT_KEY)).toBeNull();
		stop();
	});
});
