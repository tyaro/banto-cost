/**
 * Issue #289 review: a reconnect re-sync (`invalidateAll()`, reason
 * 'resync') refetches lists but must not raise unseen-change badges.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { invalidate, invalidateAll, onInvalidate } from '@banto/admin-core';
import { navBadges } from './navBadges.svelte';
import type { AppPath } from './navigation';

describe('navBadges.noteInvalidation', () => {
	const offs: (() => void)[] = [];
	afterEach(() => {
		offs.splice(0).forEach((off) => off());
		navBadges.clearFor('/nbt-items');
	});

	function wire(pathname: string) {
		offs.push(
			onInvalidate('nbt-items', (_r, reason) =>
				navBadges.noteInvalidation('/nbt-items' as AppPath, pathname, reason)
			)
		);
	}

	it('counts a real change while the user is elsewhere', () => {
		wire('/dashboard');
		invalidate('nbt-items');
		expect(navBadges.count('/nbt-items' as AppPath)).toBe(1);
	});

	it('does not count a reconnect resync', () => {
		wire('/dashboard');
		invalidateAll();
		expect(navBadges.count('/nbt-items' as AppPath)).toBe(0);
	});

	it('does not count a change on the page on screen', () => {
		wire('/nbt-items/3');
		invalidate('nbt-items');
		expect(navBadges.count('/nbt-items' as AppPath)).toBe(0);
	});
});
