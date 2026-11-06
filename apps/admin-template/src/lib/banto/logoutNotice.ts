/**
 * The toast for a logout that did not reach /login (Issue #260 実装-3,
 * independent audit P2-2): `logoutAndLeave`'s `notify` for `Header.svelte`
 * and the command palette. Kept apart from `logout.svelte.ts` so that module
 * (and its tests) needs no Paraglide messages.
 */
import { notify } from '@banto/admin-core';
import * as m from '#lib/paraglide/messages.js';
import type { LogoutOutcome } from './logout.svelte';

export function notifyLogoutOutcome(outcome: Exclude<LogoutOutcome, 'left'>): void {
	notify('error', outcome === 'stayed' ? m['auth.logoutStayed']() : m['auth.logoutUnverified']());
}
