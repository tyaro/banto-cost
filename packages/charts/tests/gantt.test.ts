import { describe, expect, it } from 'vitest';
import { ganttDomain, ganttLayout, toMs, type GanttTask } from '../src/core/gantt';

const D = (s: string) => new Date(s).getTime();

describe('toMs', () => {
	it('passes through numbers unchanged', () => {
		expect(toMs(1000)).toBe(1000);
	});
	it('converts Date to epoch ms', () => {
		expect(toMs(new Date('2026-01-01T00:00:00Z'))).toBe(D('2026-01-01T00:00:00Z'));
	});
	it('parses date strings', () => {
		expect(toMs('2026-01-01T00:00:00Z')).toBe(D('2026-01-01T00:00:00Z'));
	});
	it('yields NaN for unparseable strings', () => {
		expect(Number.isNaN(toMs('not-a-date'))).toBe(true);
	});
});

describe('ganttDomain', () => {
	it('spans the earliest start to the latest end', () => {
		const tasks: GanttTask[] = [
			{ id: 'a', label: 'A', start: '2026-01-01', end: '2026-01-05' },
			{ id: 'b', label: 'B', start: '2026-01-03', end: '2026-01-10' }
		];
		expect(ganttDomain(tasks)).toEqual([D('2026-01-01'), D('2026-01-10')]);
	});

	it('returns null when no task has a usable instant', () => {
		expect(ganttDomain([{ id: 'a', label: 'A', start: 'x', end: 'y' }])).toBeNull();
		expect(ganttDomain([])).toBeNull();
	});

	it('bounds the domain by a single usable endpoint when the other is invalid', () => {
		const dom = ganttDomain([{ id: 'a', label: 'A', start: '2026-01-01', end: 'bad' }]);
		expect(dom).toEqual([D('2026-01-01'), D('2026-01-01')]);
	});
});

describe('ganttLayout', () => {
	const domain: [number, number] = [D('2026-01-01'), D('2026-01-11')]; // 10-day span

	it('maps start/end to fractions of the domain', () => {
		const [bar] = ganttLayout(
			[{ id: 'a', label: 'A', start: '2026-01-03', end: '2026-01-06' }],
			domain
		);
		expect(bar.startFrac).toBeCloseTo(0.2, 5); // day 2 of 10
		expect(bar.widthFrac).toBeCloseTo(0.3, 5); // 3 of 10 days
		expect(bar.progressFrac).toBe(0);
		expect(bar.colorIndex).toBe(0);
	});

	it('clamps end-before-start to a zero-width bar', () => {
		const [bar] = ganttLayout(
			[{ id: 'a', label: 'A', start: '2026-01-06', end: '2026-01-03' }],
			domain
		);
		expect(bar.widthFrac).toBe(0);
	});

	it('clamps progress to 0..1 and defaults colorIndex to the row index', () => {
		const bars = ganttLayout(
			[
				{ id: 'a', label: 'A', start: '2026-01-01', end: '2026-01-06', progress: 1.5 },
				{ id: 'b', label: 'B', start: '2026-01-02', end: '2026-01-04', progress: -0.2 }
			],
			domain
		);
		expect(bars[0].progressFrac).toBe(1);
		expect(bars[1].progressFrac).toBe(0);
		expect(bars[1].colorIndex).toBe(1);
	});

	it('honors an explicit colorIndex', () => {
		const [bar] = ganttLayout(
			[{ id: 'a', label: 'A', start: '2026-01-01', end: '2026-01-02', colorIndex: 3 }],
			domain
		);
		expect(bar.colorIndex).toBe(3);
	});

	it('collapses to zero fractions when the domain has zero span', () => {
		const t = D('2026-01-01');
		const [bar] = ganttLayout(
			[{ id: 'a', label: 'A', start: '2026-01-01', end: '2026-01-01' }],
			[t, t]
		);
		expect(bar.startFrac).toBe(0);
		expect(bar.widthFrac).toBe(0);
	});
});
