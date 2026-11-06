import { describe, expect, it } from 'vitest';
import { validateDockLayout } from '../src/core/validate';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

// shared-primitives-upstream-plan §3.2 / Issue #434 (PR-1: layout validation).

function win(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		title: id.toUpperCase(),
		x: 10,
		y: 20,
		width: 300,
		height: 200,
		open: true,
		...over
	};
}

function layoutOf(floating: unknown[], docked: unknown = null) {
	return { version: 2, floating, docked };
}

const goodDocked = {
	type: 'split',
	id: 's1',
	direction: 'row',
	children: [
		{
			type: 'tabs',
			id: 't1',
			activeIndex: 1,
			children: [
				{ type: 'panel', id: 'p1', title: 'P1' },
				{ type: 'panel', id: 'p2', title: 'P2' }
			]
		},
		{ type: 'panel', id: 'p3', title: 'P3' }
	],
	sizes: [0.3, 0.7]
};

function codes(value: unknown): string[] {
	const r = validateDockLayout(value);
	return r.ok ? [] : r.issues.map((i) => `${i.code}@${i.path}`);
}

describe('validateDockLayout: accepted inputs', () => {
	it('accepts a normal v2 layout with a docked tree', () => {
		const r = validateDockLayout(layoutOf([win('a'), win('b', { x: -50, y: -5 })], goodDocked));
		expect(r.ok).toBe(true);
	});

	it('accepts a v1 payload and migrates it to v2 with docked: null', () => {
		const r = validateDockLayout({ version: 1, floating: [win('a')] });
		expect(r).toEqual({
			ok: true,
			layout: { version: 2, floating: [win('a')], docked: null }
		});
	});

	it('repairs split sizes that do not sum to 1 (normalizeSizes)', () => {
		const docked = { ...goodDocked, sizes: [1, 3] };
		const r = validateDockLayout(layoutOf([], docked));
		expect(r.ok).toBe(true);
		if (r.ok && r.layout.docked?.type === 'split') {
			expect(r.layout.docked.sizes).toEqual([0.25, 0.75]);
		}
	});

	it('does not reject ids unknown to a consumer registry (not a structural issue)', () => {
		expect(validateDockLayout(layoutOf([win('never-registered-anywhere')])).ok).toBe(true);
	});

	it('does not mutate its input', () => {
		const input = layoutOf([win('a')], goodDocked);
		const snapshot = JSON.stringify(input);
		validateDockLayout(input);
		expect(JSON.stringify(input)).toBe(snapshot);
	});
});

describe('validateDockLayout: rejected inputs (Issue #434 observations)', () => {
	it('rejects x=1e999 (JSON.parse gives Infinity)', () => {
		const parsed = JSON.parse(
			'{"version":2,"floating":[{"id":"a","title":"A","x":1e999,"y":0,"width":300,"height":200,"open":true}],"docked":null}'
		);
		expect(parsed.floating[0].x).toBe(Infinity);
		expect(codes(parsed)).toEqual(['non-finite@floating[0].x']);
	});

	it('rejects NaN coordinates', () => {
		expect(codes(layoutOf([win('a', { y: NaN })]))).toEqual(['non-finite@floating[0].y']);
	});

	it('rejects width=-1 and height=0', () => {
		expect(codes(layoutOf([win('a', { width: -1 })]))).toEqual([
			'non-positive-size@floating[0].width'
		]);
		expect(codes(layoutOf([win('a', { height: 0 })]))).toEqual([
			'non-positive-size@floating[0].height'
		]);
	});

	it('rejects a duplicate id among floating windows (id=a)', () => {
		expect(codes(layoutOf([win('a'), win('a')]))).toEqual(['duplicate-id@floating[1].id']);
	});

	it('rejects an id shared by a floating window and a docked panel', () => {
		const docked = {
			type: 'tabs',
			id: 't',
			activeIndex: 0,
			children: [{ type: 'panel', id: 'a', title: 'A' }]
		};
		expect(codes(layoutOf([win('a')], docked))).toEqual(['duplicate-id@docked.children[0].id']);
	});

	it('rejects an unknown version', () => {
		expect(codes({ version: 3, floating: [], docked: null })).toEqual(['version@version']);
		expect(codes({ floating: [] })).toEqual(['version@version']);
	});

	it('rejects non-object and structurally wrong input', () => {
		expect(validateDockLayout(null).ok).toBe(false);
		expect(validateDockLayout('x').ok).toBe(false);
		expect(validateDockLayout([]).ok).toBe(false);
		expect(codes({ version: 2, floating: [] })).toEqual(['shape@docked']);
		expect(codes({ version: 2, floating: 'no', docked: null })).toEqual(['shape@floating']);
		expect(codes({ version: 1, floating: [{ id: 'a' }] })).toContain('shape@floating[0].title');
	});

	it('rejects invalid split: too few children, sizes mismatch, negative size', () => {
		const one = { ...goodDocked, children: [goodDocked.children[1]], sizes: [1] };
		expect(codes(layoutOf([], one))).toEqual(['split-sizes@docked.children']);
		const mismatch = { ...goodDocked, sizes: [1] };
		expect(codes(layoutOf([], mismatch))).toEqual(['split-sizes@docked.sizes']);
		const negative = { ...goodDocked, sizes: [-0.2, 1.2] };
		expect(codes(layoutOf([], negative))).toEqual(['split-sizes@docked.sizes[0]']);
		const inf = { ...goodDocked, sizes: [Infinity, 1] };
		expect(codes(layoutOf([], inf))).toEqual(['split-sizes@docked.sizes[0]']);
	});

	it('rejects invalid tabs: activeIndex out of range / fractional, empty group, nested split', () => {
		const tabs = (over: Record<string, unknown>) => ({
			type: 'tabs',
			id: 't',
			activeIndex: 0,
			children: [{ type: 'panel', id: 'p', title: 'P' }],
			...over
		});
		expect(codes(layoutOf([], tabs({ activeIndex: 1 })))).toEqual([
			'active-index@docked.activeIndex'
		]);
		expect(codes(layoutOf([], tabs({ activeIndex: -1 })))).toEqual([
			'active-index@docked.activeIndex'
		]);
		expect(codes(layoutOf([], tabs({ activeIndex: 0.5 })))).toEqual([
			'active-index@docked.activeIndex'
		]);
		expect(codes(layoutOf([], tabs({ children: [] })))).toEqual(['shape@docked.children']);
		expect(codes(layoutOf([], tabs({ children: [goodDocked] })))).toContain(
			'shape@docked.children[0].type'
		);
	});

	it('reports every issue at once', () => {
		const r = validateDockLayout(layoutOf([win('a', { x: Infinity, width: -1 }), win('a')]));
		expect(r.ok).toBe(false);
		if (!r.ok)
			expect(r.issues.map((i) => i.code).sort()).toEqual([
				'duplicate-id',
				'non-finite',
				'non-positive-size'
			]);
	});
});

describe('DockState adopts only validated layouts', () => {
	const bad = [
		[
			'x=1e999',
			'{"version":2,"floating":[{"id":"a","title":"A","x":1e999,"y":0,"width":300,"height":200,"open":true}],"docked":null}'
		],
		['width=-1', JSON.stringify(layoutOf([win('a', { width: -1 })]))],
		['height=0', JSON.stringify(layoutOf([win('a', { height: 0 })]))],
		['duplicate id=a', JSON.stringify(layoutOf([win('a'), win('a')]))]
	] as const;

	it.each(bad)('hydrate(%s) returns false and leaves the current layout untouched', (_n, json) => {
		const dock = createDockState(layoutOf([win('keep')]) as unknown as DockLayout);
		const before = JSON.stringify(dock.layout);
		expect(dock.hydrate(json)).toBe(false);
		expect(JSON.stringify(dock.layout)).toBe(before);
	});

	it('hydrate returns false for malformed JSON and true for a valid payload', () => {
		const dock = createDockState();
		expect(dock.hydrate('not json{{{')).toBe(false);
		expect(dock.hydrate(JSON.stringify(layoutOf([win('a')], goodDocked)))).toBe(true);
		expect(dock.layout.floating[0].id).toBe('a');
	});

	it.each(bad)('constructor with string %s starts from an empty layout', (_n, json) => {
		expect(createDockState(json).layout).toEqual({ version: 2, floating: [], docked: null });
	});

	it('constructor with an invalid object starts from an empty layout (no throw)', () => {
		const invalid = layoutOf([win('a', { x: NaN }), win('a')]) as unknown as DockLayout;
		expect(createDockState(invalid).layout).toEqual({ version: 2, floating: [], docked: null });
	});

	it('constructor still accepts a normal v2 object and a v1 object', () => {
		const v2 = layoutOf([win('a')], goodDocked) as unknown as DockLayout;
		expect(createDockState(v2).layout.floating[0].id).toBe('a');
		const v1 = { version: 1, floating: [win('a')] } as unknown as DockLayout;
		expect(createDockState(v1).layout).toEqual({ version: 2, floating: [win('a')], docked: null });
	});
});

describe('caller-supplied objects that JSON cannot produce (PR #440 review)', () => {
	it('rejects split weights whose sum overflows to Infinity', () => {
		const docked = {
			type: 'split',
			id: 's1',
			direction: 'row',
			children: [
				{ type: 'panel', id: 'p1', title: 'P1' },
				{ type: 'panel', id: 'p2', title: 'P2' }
			],
			sizes: [1e308, 1e308]
		};
		const result = validateDockLayout(layoutOf([], docked));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual({ code: 'split-sizes', path: 'docked.sizes' });
		}
	});

	it('stops at a split that contains itself instead of recursing forever', () => {
		const split: Record<string, unknown> = {
			type: 'split',
			id: 's1',
			direction: 'row',
			sizes: [1, 1]
		};
		split.children = [split, { type: 'panel', id: 'p1', title: 'P1' }];
		const result = validateDockLayout(layoutOf([], split));
		expect(result.ok).toBe(false);
		expect(() => createDockState(layoutOf([], split) as unknown as DockLayout)).not.toThrow();
	});

	it('rejects holes in sparse tab children and floating arrays', () => {
		const tabs = { type: 'tabs', id: 't1', activeIndex: 0, children: new Array(1) };
		const sparseTabs = validateDockLayout(layoutOf([], tabs));
		expect(sparseTabs.ok).toBe(false);
		if (!sparseTabs.ok) {
			expect(sparseTabs.issues).toContainEqual({ code: 'shape', path: 'docked.children[0]' });
		}

		const floating: unknown[] = [win('a')];
		floating.length = 2;
		const sparseFloating = validateDockLayout(layoutOf(floating));
		expect(sparseFloating.ok).toBe(false);
		if (!sparseFloating.ok) {
			expect(sparseFloating.issues).toContainEqual({ code: 'shape', path: 'floating[1]' });
		}
	});
});
