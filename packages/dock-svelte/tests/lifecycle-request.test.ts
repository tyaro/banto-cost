// @vitest-environment jsdom
//
// The request rules of `PanelLifecycle` (#432 review on PR #448): an async
// answer is checked against the structure GENERATION (`DockState.
// structureRevision`), not two keys - a structure that came back to the same
// shape is still stale; the IME hold is checked again when the answer arrives;
// a held request keeps the generation of the moment it was held; `remount` /
// `from` are re-described right before applying; requests to different
// destinations are told apart; dispose resolves every waiting request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelLifecycle, type DockPanelChange } from '../src/core/lifecycle';
import { structureKey } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockTabGroupNode } from '../src/types';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const layout = (): DockLayout => ({
	version: 2,
	floating: [
		{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true },
		{ id: 'b', title: 'B', x: 500, y: 300, width: 300, height: 200, open: true }
	],
	docked: {
		type: 'tabs',
		id: 't',
		activeIndex: 0,
		children: [
			{ type: 'panel', id: 'x', title: 'X' },
			{ type: 'panel', id: 'y', title: 'Y' }
		]
	}
});

const winOf = (dock: DockState, id: string) => dock.layout.floating.find((w) => w.id === id)!;
const active = (dock: DockState) => (dock.layout.docked as DockTabGroupNode).activeIndex;

let detach: (() => void) | null = null;
afterEach(() => {
	detach?.();
	detach = null;
	document.body.innerHTML = '';
});

function setup(options: {
	hook?: (change: DockPanelChange) => boolean | Promise<boolean>;
	keepMounted?: (id: string) => boolean;
	deferred?: () => boolean;
}) {
	const dock = createDockState(layout());
	const lifecycle = new PanelLifecycle(dock, () => ({
		beforePanelChange: options.hook,
		keepMounted: options.keepMounted,
		isStructureChangeDeferred: options.deferred
	}));
	detach = lifecycle.attach();
	return { dock, lifecycle };
}

describe('structureRevision', () => {
	it('counts structure changes only, also ones that come back to the same shape', () => {
		const dock = createDockState(layout());
		const start = dock.structureRevision;
		dock.move('a', 10, 10, 1000, 600);
		dock.focus('a');
		dock.resize('a', 'se', 10, 10, 1000, 600);
		expect(dock.structureRevision).toBe(start);
		dock.close('a');
		dock.open('a');
		expect(dock.structureRevision).toBe(start + 2);
		dock.setActiveTab('t', 1);
		dock.setActiveTab('t', 0);
		expect(dock.structureRevision).toBe(start + 4);
		dock.layout = { ...dock.layout }; // same structure, new object
		expect(dock.structureRevision).toBe(start + 4);
	});
});

describe('the structure generation decides stale (review 2)', () => {
	it('close -> open (a re-mount) while a close waits: the old approval is stale', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const pending = lifecycle.close('a');
		dock.close('a');
		dock.open('a');
		expect(structureKey(dock.layout)).toBe(structureKey(layout())); // same shape again
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('tab A -> B -> A while a tab switch waits: stale', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const pending = lifecycle.switchTab('t', 'y');
		dock.setActiveTab('t', 1);
		dock.setActiveTab('t', 0);
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(active(dock)).toBe(0);
	});

	it('geometry, split sizes and z-order still do not count', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const pending = lifecycle.close('a');
		dock.move('a', 30, 30, 1000, 600);
		dock.focus('b');
		answer.resolve(true);
		expect(await pending).toBe('applied');
		expect(winOf(dock, 'a').open).toBe(false);
	});
});

describe('IME composition is checked again when the answer arrives (review 1)', () => {
	it('a composition that starts while the hook waits holds the approval until compositionend', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const input = document.body.appendChild(document.createElement('input'));
		const pending = lifecycle.close('a');
		input.focus();
		input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
		answer.resolve(true);
		await nextTask();
		expect(winOf(dock, 'a').open).toBe(true); // not torn down mid-composition
		input.dispatchEvent(new Event('compositionend', { bubbles: true }));
		await nextTask();
		expect(await pending).toBe('applied');
		expect(winOf(dock, 'a').open).toBe(false);
	});

	it('a custom predicate that turns true while waiting holds until resumeDeferred; a change meanwhile is stale', async () => {
		let deferring = false;
		const hook = vi.fn(() => answer.promise);
		let answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook, deferred: () => deferring });
		const pending = lifecycle.close('a');
		deferring = true;
		answer.resolve(true);
		await nextTask();
		expect(winOf(dock, 'a').open).toBe(true);
		dock.close('b');
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
		expect(hook).toHaveBeenCalledTimes(1); // the approval is not asked again

		answer = deferred<boolean>();
		const ok = lifecycle.close('a');
		deferring = true;
		answer.resolve(true);
		await nextTask();
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await ok).toBe('applied');
	});
});

describe('a held request keeps the generation of the moment it was held (review 5)', () => {
	it('the app switches the tab while a tab switch is held: stale, the hook is not asked with an old from', async () => {
		let deferring = true;
		const hook = vi.fn(() => true);
		const { dock, lifecycle } = setup({ hook, deferred: () => deferring });
		const held = lifecycle.switchTab('t', 'y');
		dock.setActiveTab('t', 1);
		dock.setActiveTab('t', 0); // back to the same shape: still a change
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await held).toBe('stale');
		expect(hook).not.toHaveBeenCalled();
		expect(active(dock)).toBe(0);
	});
});

describe('keepMounted is re-checked right before applying (review 4)', () => {
	it('a hide asked as remount: false is stale once keepMounted turned false', async () => {
		let keep = true;
		const answer = deferred<boolean>();
		const calls: DockPanelChange[] = [];
		const { dock, lifecycle } = setup({
			hook: (c) => (calls.push(c), answer.promise),
			keepMounted: () => keep
		});
		const pending = lifecycle.closeButton('a');
		expect(calls).toEqual([{ kind: 'hide', panelId: 'a', remount: false }]);
		keep = false;
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('a tab switch asked as remount: true is stale once the from pane became keepMounted', async () => {
		let keep = false;
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise, keepMounted: () => keep });
		const pending = lifecycle.switchTab('t', 'y');
		keep = true;
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(active(dock)).toBe(0);
	});
});

describe('requests to different destinations are told apart (review 3)', () => {
	it('the same change with another target is asked on its own; the first approved applies, the other is stale', async () => {
		const answers = [deferred<boolean>(), deferred<boolean>()];
		const hook = vi.fn(() => answers[hook.mock.calls.length - 1].promise);
		const { dock, lifecycle } = setup({ hook });
		const applied: string[] = [];
		const change: DockPanelChange = { kind: 'dock', panelId: 'a', remount: true };
		const toX = lifecycle.request(change, () => applied.push('x'), { target: { to: 'x' } });
		const toY = lifecycle.request(
			change,
			() => {
				applied.push('y');
				dock.close('a'); // a structure change, as a real dock would make
			},
			{ target: { to: 'y' } }
		);
		const againY = lifecycle.request(change, () => applied.push('y2'), { target: { to: 'y' } });
		expect(hook).toHaveBeenCalledTimes(2);
		expect(againY).toBe(toY);
		answers[1].resolve(true);
		expect(await toY).toBe('applied');
		answers[0].resolve(true);
		expect(await toX).toBe('stale');
		expect(applied).toEqual(['y']);
	});
});

describe('dispose resolves every waiting request (review 6)', () => {
	it('a hook promise that never settles resolves disposed and lets go of apply', async () => {
		const apply = vi.fn();
		const { lifecycle } = setup({ hook: () => new Promise<boolean>(() => {}) });
		const close = lifecycle.close('a');
		const other = lifecycle.request({ kind: 'close', panelId: 'b' }, apply);
		lifecycle.dispose();
		expect(await close).toBe('disposed');
		expect(await other).toBe('disposed');
		expect(apply).not.toHaveBeenCalled();
		expect(await lifecycle.close('a')).toBe('disposed');
	});
});

describe('a late approval does not push out a newer held request (PR #448 re-review)', () => {
	function hookFor(answerA: Promise<boolean>) {
		return vi.fn((change: DockPanelChange) =>
			'panelId' in change && change.panelId === 'a' ? answerA : true
		);
	}

	it('a stale A approved late leaves the current held B in place, and B applies on resume', async () => {
		let deferring = false;
		const answerA = deferred<boolean>();
		const { dock, lifecycle } = setup({
			hook: hookFor(answerA.promise),
			deferred: () => deferring
		});
		const a = lifecycle.close('a');
		dock.setActiveTab('t', 1); // another structure change: A's request is now stale
		deferring = true;
		const b = lifecycle.close('b'); // held under the current generation
		answerA.resolve(true);
		expect(await a).toBe('stale');
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await b).toBe('applied');
		expect(winOf(dock, 'b').open).toBe(false);
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('an older current approval arriving after a newer held request is the one superseded', async () => {
		let deferring = false;
		const answerA = deferred<boolean>();
		const { dock, lifecycle } = setup({
			hook: hookFor(answerA.promise),
			deferred: () => deferring
		});
		const a = lifecycle.close('a');
		deferring = true;
		const b = lifecycle.close('b');
		answerA.resolve(true);
		expect(await a).toBe('superseded');
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await b).toBe('applied');
		expect(winOf(dock, 'a').open).toBe(true);
	});
});
