/**
 * Unsaved-changes guard (spec §7, issue #214): the pure decision table and
 * the per-navigation check. The component-level wiring (registry join/leave
 * on mount/destroy, one prompt for several guards) is covered in
 * unsavedChangesGuard.test.ts under jsdom.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
	decideLeave,
	isApprovedExit,
	isSamePage,
	runLeaveCheck,
	type LeaveDecision,
	type LeaveDecisionInput,
	type LeaveNavigation,
	type UnsavedChangesSource
} from '../src/unsavedChanges.svelte';

function nav(
	type: string,
	from: string | null,
	to: string | null
): LeaveNavigation & { cancel: Mock<() => void> } {
	return {
		type,
		from: from ? { url: new URL(from, 'http://app.test') } : null,
		to: to ? { url: new URL(to, 'http://app.test') } : null,
		cancel: vi.fn<() => void>()
	};
}

function source(pending: boolean, text = 'unsaved'): UnsavedChangesSource {
	return { isPending: () => pending, message: () => text };
}

describe('decideLeave', () => {
	const cases: [Partial<LeaveDecisionInput>, LeaveDecision][] = [
		// Nothing unsaved: never ask, whatever the navigation.
		[{ pending: false, type: 'link' }, 'allow'],
		[{ pending: false, type: 'leave' }, 'allow'],
		[{ pending: false, type: 'popstate' }, 'allow'],
		// Unsaved + in-app move: ask.
		[{ pending: true, type: 'link' }, 'confirm'],
		[{ pending: true, type: 'goto' }, 'confirm'],
		[{ pending: true, type: 'popstate' }, 'confirm'],
		[{ pending: true, type: 'form' }, 'confirm'],
		// Unsaved + reload / tab close: the browser's own prompt.
		[{ pending: true, type: 'leave' }, 'block'],
		// Forced moves (logout, session end) never hold the user back.
		[{ pending: true, type: 'goto', forced: true }, 'allow'],
		[{ pending: true, type: 'leave', forced: true }, 'allow'],
		// Staying on the same page keeps the draft mounted: nothing to lose.
		[{ pending: true, type: 'link', samePage: true }, 'allow']
	];

	it.each(cases)('%o -> %s', (input, expected) => {
		expect(
			decideLeave({ pending: false, forced: false, samePage: false, type: 'link', ...input })
		).toBe(expected);
	});
});

describe('isSamePage', () => {
	it('ignores the hash but not the path or query', () => {
		expect(isSamePage(nav('link', '/items/1', '/items/1#top'))).toBe(true);
		expect(isSamePage(nav('link', '/items/1', '/items/2'))).toBe(false);
		expect(isSamePage(nav('link', '/items?a=1', '/items?a=2'))).toBe(false);
	});

	it('is false when either end is unknown (unload / external)', () => {
		expect(isSamePage(nav('leave', '/items/1', null))).toBe(false);
		expect(isSamePage(nav('link', null, '/items/1'))).toBe(false);
	});
});

describe('runLeaveCheck', () => {
	it('allows without asking when nothing is pending', () => {
		const confirm = vi.fn(() => false);
		const navigation = nav('link', '/items/new', '/dashboard');
		expect(runLeaveCheck(navigation, [source(false)], { confirm })).toBe('allow');
		expect(confirm).not.toHaveBeenCalled();
		expect(navigation.cancel).not.toHaveBeenCalled();
	});

	it('cancels when the user chooses to stay', () => {
		const confirm = vi.fn(() => false);
		const navigation = nav('link', '/items/new', '/dashboard');
		expect(runLeaveCheck(navigation, [source(true, 'discard?')], { confirm })).toBe('kept');
		expect(confirm).toHaveBeenCalledWith('discard?');
		expect(navigation.cancel).toHaveBeenCalledOnce();
	});

	it('lets the navigation through when the user chooses to leave', () => {
		const navigation = nav('link', '/items/new', '/dashboard');
		expect(runLeaveCheck(navigation, [source(true)], { confirm: () => true })).toBe('confirmed');
		expect(navigation.cancel).not.toHaveBeenCalled();
	});

	it('asks if ANY source is pending, with that source message', () => {
		const confirm = vi.fn(() => true);
		const navigation = nav('goto', '/settings/connectivity', '/dashboard');
		runLeaveCheck(navigation, [source(false, 'clean'), source(true, 'dirty')], { confirm });
		expect(confirm).toHaveBeenCalledWith('dirty');
	});

	it('answers each navigation once, however many guards see it', () => {
		const confirm = vi.fn(() => false);
		const navigation = nav('link', '/items/new', '/dashboard');
		const sources = [source(true), source(true)];
		expect(runLeaveCheck(navigation, sources, { confirm })).toBe('kept');
		expect(runLeaveCheck(navigation, sources, { confirm })).toBe('already-handled');
		expect(confirm).toHaveBeenCalledOnce();
		expect(navigation.cancel).toHaveBeenCalledOnce();
	});

	it('cancels an unload without calling confirm (native prompt instead)', () => {
		const confirm = vi.fn(() => true);
		const navigation = nav('leave', '/items/new', null);
		expect(runLeaveCheck(navigation, [source(true)], { confirm })).toBe('block');
		expect(confirm).not.toHaveBeenCalled();
		expect(navigation.cancel).toHaveBeenCalledOnce();
	});

	it('never asks for a forced navigation', () => {
		const confirm = vi.fn(() => false);
		const navigation = nav('goto', '/items/new', '/login');
		const isForced = (n: LeaveNavigation) => n.to?.url.pathname === '/login';
		expect(runLeaveCheck(navigation, [source(true)], { confirm, isForced })).toBe('allow');
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe('isApprovedExit', () => {
	const withComplete = (n: LeaveNavigation) => ({ ...n, complete: Promise.resolve() });

	it('is true only for a go-ahead to another page whose end is observable', () => {
		const away = withComplete(nav('link', '/items/new', '/dashboard'));
		expect(isApprovedExit('confirmed', away)).toBe(true);
		expect(isApprovedExit('allow', away)).toBe(true);
		expect(isApprovedExit('kept', away)).toBe(false);
		expect(isApprovedExit('block', away)).toBe(false);
		expect(isApprovedExit(undefined, away)).toBe(false);
	});

	it('excludes same-page moves, unloads and navigations without `complete`', () => {
		expect(isApprovedExit('allow', withComplete(nav('link', '/a', '/a#x')))).toBe(false);
		expect(isApprovedExit('allow', withComplete(nav('leave', '/a', null)))).toBe(false);
		expect(isApprovedExit('confirmed', nav('link', '/a', '/b'))).toBe(false);
	});
});
