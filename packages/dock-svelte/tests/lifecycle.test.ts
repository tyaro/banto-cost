// What makes an async `beforePanelChange` answer stale (#432,
// shared-primitives-upstream-plan §3.5, `core/lifecycle.ts#structureKey`): the
// structure counts (docked shape, active tab, floating ids and open flags);
// geometry, split sizes and z-order do not.
import { describe, expect, it } from 'vitest';
import { structureKey } from '../src/core/lifecycle';
import type { DockLayout } from '../src/types';

const base = (): DockLayout => ({
	version: 2,
	floating: [
		{ id: 'a', title: 'A', x: 0, y: 0, width: 300, height: 200, open: true },
		{ id: 'b', title: 'B', x: 50, y: 50, width: 300, height: 200, open: true }
	],
	docked: {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.5, 0.5],
		children: [
			{
				type: 'tabs',
				id: 't',
				activeIndex: 0,
				children: [
					{ type: 'panel', id: 'x', title: 'X' },
					{ type: 'panel', id: 'y', title: 'Y' }
				]
			},
			{ type: 'panel', id: 'p', title: 'P' }
		]
	}
});

describe('structureKey', () => {
	it('ignores geometry, split sizes and z-order', () => {
		const changed = base();
		changed.floating = [
			{ ...changed.floating[1], x: 999 },
			{ ...changed.floating[0], width: 10 }
		];
		const split = changed.docked as Extract<DockLayout['docked'], { type: 'split' }>;
		split.sizes = [0.2, 0.8];
		expect(structureKey(changed)).toBe(structureKey(base()));
	});

	it.each([
		['an open flag', (l: DockLayout) => (l.floating[0].open = false)],
		['a floating window removed', (l: DockLayout) => l.floating.pop()],
		[
			'the active tab',
			(l: DockLayout) => {
				const split = l.docked as { children: { activeIndex: number }[] };
				split.children[0].activeIndex = 1;
			}
		],
		[
			'the docked shape',
			(l: DockLayout) => {
				const split = l.docked as { children: unknown[] };
				split.children.pop();
			}
		],
		[
			'the split direction',
			(l: DockLayout) => ((l.docked as { direction: string }).direction = 'column')
		]
	])('sees %s', (_name, mutate) => {
		const changed = base();
		mutate(changed);
		expect(structureKey(changed)).not.toBe(structureKey(base()));
	});

	it('does not confuse floating ids that contain delimiters', () => {
		const win = (id: string) => ({ id, title: id, x: 0, y: 0, width: 10, height: 10, open: true });
		const two: DockLayout = { version: 2, floating: [win('t'), win('a:1,b')], docked: null };
		const three: DockLayout = {
			version: 2,
			floating: [win('t'), win('a'), win('b')],
			docked: null
		};
		expect(structureKey(two)).not.toBe(structureKey(three));
	});
});
