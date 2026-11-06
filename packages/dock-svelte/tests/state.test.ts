import { describe, expect, it } from 'vitest';
import { DockState, createDockState } from '../src/state.svelte';
import type { DockLayout, DockSplitNode, DockTabGroupNode } from '../src/types';

const HOST_W = 800;
const HOST_H = 600;

// Deterministic id generator for tests that need to assert on generated
// split/tabs node ids.
function counterMakeId(): () => string {
	let n = 0;
	return () => `gen-${n++}`;
}

describe('DockState.ensureWindow', () => {
	it('adds a window once, at a cascade position', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		expect(dock.layout.floating).toHaveLength(1);
		expect(dock.layout.floating[0]).toMatchObject({ id: 'a', title: 'A', open: true });

		dock.ensureWindow({ id: 'a', title: 'A (renamed, ignored)' }, HOST_W, HOST_H);
		expect(dock.layout.floating).toHaveLength(1);
		expect(dock.layout.floating[0].title).toBe('A');
	});

	it('keeps saved geometry for an existing (even closed) window instead of re-cascading it', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.move('a', 123, 45, HOST_W, HOST_H);
		dock.close('a');
		const before = { ...dock.layout.floating[0] };

		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);

		expect(dock.layout.floating[0]).toEqual(before);
		expect(dock.isOpen('a')).toBe(false);
	});

	it('cascades multiple new windows at increasing offsets', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		const [a, b] = dock.layout.floating;
		expect(b.x).toBeGreaterThan(a.x);
		expect(b.y).toBeGreaterThan(a.y);
	});
});

describe('DockState open/close/toggle', () => {
	function seeded(): DockState {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		return dock;
	}

	it('open/close/isOpen roundtrip', () => {
		const dock = seeded();
		expect(dock.isOpen('a')).toBe(true);
		dock.close('a');
		expect(dock.isOpen('a')).toBe(false);
		dock.open('a');
		expect(dock.isOpen('a')).toBe(true);
	});

	it('toggle flips open state', () => {
		const dock = seeded();
		dock.toggle('a');
		expect(dock.isOpen('a')).toBe(false);
		dock.toggle('a');
		expect(dock.isOpen('a')).toBe(true);
	});

	it('open/close/toggle on an unknown id is a no-op', () => {
		const dock = seeded();
		dock.open('zzz');
		dock.close('zzz');
		dock.toggle('zzz');
		expect(dock.layout.floating).toHaveLength(1);
	});
});

describe('DockState.focus', () => {
	it('reorders the target window to the end (frontmost)', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'c', title: 'C' }, HOST_W, HOST_H);

		dock.focus('a');
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['b', 'c', 'a']);
	});

	it('open() brings the window to front too', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.close('a');

		dock.open('a');
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['b', 'a']);
	});
});

describe('DockState move/resize', () => {
	it('move shifts the window and clamps to the host', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A', width: 300, height: 200 }, HOST_W, HOST_H);
		const before = dock.layout.floating[0];
		dock.move('a', 50, 20, HOST_W, HOST_H);
		const after = dock.layout.floating[0];
		expect(after.x).toBe(before.x + 50);
		expect(after.y).toBe(before.y + 20);
	});

	it('resize changes size via the se handle', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A', width: 300, height: 200 }, HOST_W, HOST_H);
		const before = dock.layout.floating[0];
		dock.resize('a', 'se', 80, 60, HOST_W, HOST_H);
		const after = dock.layout.floating[0];
		expect(after.width).toBe(before.width + 80);
		expect(after.height).toBe(before.height + 60);
		expect(after.x).toBe(before.x);
		expect(after.y).toBe(before.y);
	});
});

describe('DockState serialize/hydrate', () => {
	it('round-trips through JSON', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.move('b', 10, 10, HOST_W, HOST_H);
		dock.close('a');

		const json = dock.serialize();
		const restored = createDockState();
		restored.hydrate(json);

		expect(restored.layout).toEqual(dock.layout);
	});

	it('hydrate on garbage input is a no-op', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		const before = JSON.parse(JSON.stringify(dock.layout));

		dock.hydrate('not json{{{');
		expect(dock.layout).toEqual(before);

		dock.hydrate(JSON.stringify({ version: 2, floating: [] }));
		expect(dock.layout).toEqual(before);

		dock.hydrate(JSON.stringify({ version: 1, floating: [{ id: 'a' }] }));
		expect(dock.layout).toEqual(before);

		dock.hydrate('null');
		expect(dock.layout).toEqual(before);
	});

	it('hydrate keeps unknown ids as-is (pruning is the host component job)', () => {
		const layout: DockLayout = {
			version: 2,
			floating: [{ id: 'ghost', title: 'Ghost', x: 0, y: 0, width: 200, height: 150, open: true }],
			docked: null
		};
		const dock = createDockState();
		dock.hydrate(JSON.stringify(layout));
		expect(dock.layout.floating).toHaveLength(1);
		expect(dock.layout.floating[0].id).toBe('ghost');
	});

	it('the constructor accepts a serialized string directly', () => {
		const seed = createDockState();
		seed.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		const dock = createDockState(seed.serialize());
		expect(dock.layout).toEqual(seed.layout);
	});

	it('the constructor accepts a DockLayout object directly', () => {
		const layout: DockLayout = { version: 2, floating: [], docked: null };
		const dock = createDockState(layout);
		expect(dock.layout).toEqual(layout);
	});

	it('hydrate migrates a v1 (M7) payload to v2 with docked: null', () => {
		const v1 = {
			version: 1,
			floating: [{ id: 'a', title: 'A', x: 1, y: 2, width: 300, height: 200, open: true }]
		};
		const dock = createDockState();
		dock.hydrate(JSON.stringify(v1));
		expect(dock.layout).toEqual({ version: 2, floating: v1.floating, docked: null });
	});
});

describe('DockState.reset', () => {
	it('restores cascade defaults for the given defs, all open', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.move('a', 500, 400, HOST_W, HOST_H);
		dock.close('a');

		dock.reset(
			[
				{ id: 'a', title: 'A' },
				{ id: 'b', title: 'B' }
			],
			HOST_W,
			HOST_H
		);

		expect(dock.layout.floating).toHaveLength(2);
		expect(dock.layout.floating.every((w) => w.open)).toBe(true);
		const a = dock.layout.floating.find((w) => w.id === 'a')!;
		expect(a.x).toBe(0);
		expect(a.y).toBe(0);
	});

	it('also clears the docked tree', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center'); // wrap the sole floating window in-place -> a bare docked panel
		expect(dock.layout.docked).not.toBeNull();

		dock.reset([{ id: 'b', title: 'B' }], HOST_W, HOST_H);
		expect(dock.layout.docked).toBeNull();
	});
});

describe('DockState.dockPanel', () => {
	it('moves a floating window into the docked tree and removes it from floating', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A', icon: '📈' }, HOST_W, HOST_H);
		expect(dock.layout.docked).toBeNull();

		// Docking onto an id not present anywhere (no docked root yet) just
		// seeds the docked root with the panel itself.
		dock.dockPanel('a', 'a', 'center');

		expect(dock.layout.floating).toHaveLength(0);
		expect(dock.layout.docked).toEqual({ type: 'panel', id: 'a', title: 'A', icon: '📈' });
	});

	it('docks a second floating panel next to the first as a split', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);

		dock.dockPanel('a', 'a', 'center');
		dock.dockPanel('b', 'a', 'right');

		expect(dock.layout.floating).toHaveLength(0);
		const docked = dock.layout.docked as DockSplitNode;
		expect(docked.type).toBe('split');
		expect(docked.direction).toBe('row');
		expect(docked.children.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('is a no-op when panelId is not currently floating', () => {
		const dock = createDockState();
		dock.dockPanel('nope', 'whatever', 'center');
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating).toEqual([]);
	});
});

describe('DockState.undockPanel', () => {
	function dockedPair(): DockState {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B', icon: '🥧' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center');
		dock.dockPanel('b', 'a', 'right');
		return dock;
	}

	it('moves a docked panel back to floating, collapsing the split', () => {
		const dock = dockedPair();
		dock.undockPanel('b', { x: 10, y: 20, width: 300, height: 200 });

		expect(dock.layout.docked).toEqual({ type: 'panel', id: 'a', title: 'A' });
		expect(dock.layout.floating).toHaveLength(1);
		expect(dock.layout.floating[0]).toMatchObject({
			id: 'b',
			title: 'B',
			icon: '🥧',
			x: 10,
			y: 20,
			width: 300,
			height: 200,
			open: true
		});
	});

	it('falls back to an index-based cascade when no geometry is given', () => {
		const dock = dockedPair();
		dock.undockPanel('b');
		expect(dock.layout.floating[0].x).toBe(0);
		expect(dock.layout.floating[0].y).toBe(0);
	});

	it('is a no-op when panelId is not currently docked', () => {
		const dock = createDockState();
		dock.undockPanel('nope');
		expect(dock.layout.floating).toEqual([]);
		expect(dock.layout.docked).toBeNull();
	});
});

describe('DockState.dockExisting', () => {
	it('relocates an already-docked panel to a new spot', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'c', title: 'C' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center');
		dock.dockPanel('b', 'a', 'right');
		dock.dockPanel('c', 'a', 'center'); // 'a' becomes a tabs group [a, c]

		dock.dockExisting('c', 'b', 'center'); // move 'c' out of the 'a' tabs group onto 'b'

		const docked = dock.layout.docked as DockSplitNode;
		expect(docked.children[0]).toEqual({ type: 'panel', id: 'a', title: 'A' }); // collapsed back to a bare panel
		const bGroup = docked.children[1] as DockTabGroupNode;
		expect(bGroup.type).toBe('tabs');
		expect(bGroup.children.map((c) => c.id)).toEqual(['b', 'c']);
	});

	it('is a no-op when panelId is not currently docked', () => {
		const dock = createDockState();
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.dockExisting('a', 'zzz', 'center'); // 'a' is floating, not docked
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating).toHaveLength(1);
	});
});

describe('DockState tab/split delegation', () => {
	function tabbedGroup(): DockState {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center');
		dock.dockPanel('b', 'a', 'center'); // -> tabs group [a, b], id 'gen-0'
		return dock;
	}

	it('setActiveTab changes the active index', () => {
		const dock = tabbedGroup();
		const group = dock.layout.docked as DockTabGroupNode;
		expect(group.activeIndex).toBe(1);
		dock.setActiveTab(group.id, 0);
		expect((dock.layout.docked as DockTabGroupNode).activeIndex).toBe(0);
	});

	it('moveTab reorders tabs', () => {
		const dock = tabbedGroup();
		const group = dock.layout.docked as DockTabGroupNode;
		dock.moveTab(group.id, 0, 1);
		expect((dock.layout.docked as DockTabGroupNode).children.map((c) => c.id)).toEqual(['b', 'a']);
	});

	it('resizeSplit adjusts a split created via dockPanel', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center');
		dock.dockPanel('b', 'a', 'right');

		const split = dock.layout.docked as DockSplitNode;
		dock.resizeSplit(split.id, 0, 0.2);

		const resized = dock.layout.docked as DockSplitNode;
		expect(resized.sizes[0]).toBeCloseTo(0.7);
		expect(resized.sizes[1]).toBeCloseTo(0.3);
	});
});

describe('DockState.ensurePanel', () => {
	it('falls through to floating ensureWindow behavior when there is no docked root and no target', () => {
		const dock = createDockState();
		dock.ensurePanel({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating).toHaveLength(1);
		expect(dock.layout.floating[0]).toMatchObject({ id: 'a', title: 'A', open: true });
	});

	it('docks into the existing docked root once one exists', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensurePanel({ id: 'a', title: 'A' }, HOST_W, HOST_H); // seeds floating (no docked root yet)
		dock.dockPanel('a', 'a', 'center'); // now docked root = bare panel 'a'

		dock.ensurePanel({ id: 'b', title: 'B' }, HOST_W, HOST_H); // docked root exists -> joins it

		expect(dock.layout.floating).toHaveLength(0);
		const group = dock.layout.docked as DockTabGroupNode;
		expect(group.type).toBe('tabs');
		expect(group.children.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('is a no-op if the id already exists anywhere (floating or docked)', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensurePanel({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center');

		dock.ensurePanel({ id: 'a', title: 'A (renamed, ignored)' }, HOST_W, HOST_H);
		expect(dock.layout.docked).toEqual({ type: 'panel', id: 'a', title: 'A' });
	});
});

describe('DockState serialize/hydrate round-trip with a nested docked tree', () => {
	it('round-trips a v2 layout with a split containing a tabs group and a panel', () => {
		const dock = createDockState(undefined, counterMakeId());
		dock.ensureWindow({ id: 'a', title: 'A' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'b', title: 'B' }, HOST_W, HOST_H);
		dock.ensureWindow({ id: 'c', title: 'C' }, HOST_W, HOST_H);
		dock.dockPanel('a', 'a', 'center');
		dock.dockPanel('b', 'a', 'center'); // tabs group [a, b]
		dock.dockPanel('c', 'a', 'right'); // split [tabsGroup, c]

		const json = dock.serialize();
		const restored = createDockState();
		restored.hydrate(json);

		expect(restored.layout).toEqual(dock.layout);
		expect(restored.layout.version).toBe(2);
		const split = restored.layout.docked as DockSplitNode;
		expect(split.type).toBe('split');
		expect((split.children[0] as DockTabGroupNode).type).toBe('tabs');
	});
});
