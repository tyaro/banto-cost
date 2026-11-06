import { describe, expect, it, vi } from 'vitest';
import { formatTooltipValue, type TooltipSeriesInfo } from '../src/core/tooltip';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import LineChartSrc from '../src/LineChart.svelte?raw';

const left: TooltipSeriesInfo = { id: 'a', label: 'A', axis: 'left' };
const right: TooltipSeriesInfo = { id: 'b', label: 'B', axis: 'right' };
const fl = (n: number) => `L${n}`;
const fr = (n: number) => `R${n}`;

describe('formatTooltipValue', () => {
	it('without formatTooltip uses the left / right axis formatter', () => {
		expect(formatTooltipValue(3, left, 0, undefined, fl, fr)).toBe('L3');
		expect(formatTooltipValue(3, right, 0, undefined, fl, fr)).toBe('R3');
	});

	it('with formatTooltip it replaces the axis formatters for the row only', () => {
		const ft = (v: number) => `T${v}`;
		expect(formatTooltipValue(3, left, 0, ft, fl, fr)).toBe('T3');
		expect(formatTooltipValue(3, right, 0, ft, fl, fr)).toBe('T3');
		// the tick formatters are untouched
		expect(fl(3)).toBe('L3');
	});

	it('passes the series info and index; supports per-series formatting', () => {
		const ft = vi.fn((v: number, s: TooltipSeriesInfo) =>
			s.id === 'bit' ? (v >= 0.5 ? 'True' : 'False') : String(v)
		);
		const bit: TooltipSeriesInfo = { id: 'bit', label: 'Run', axis: 'left' };
		expect(formatTooltipValue(1, bit, 7, ft, fl, fr)).toBe('True');
		expect(formatTooltipValue(0, bit, 8, ft, fl, fr)).toBe('False');
		expect(formatTooltipValue(0.5, bit, 9, ft, fl, fr)).toBe('True');
		expect(formatTooltipValue(12.5, right, 2, ft, fl, fr)).toBe('12.5');
		expect(ft).toHaveBeenNthCalledWith(1, 1, bit, 7);
		expect(ft).toHaveBeenNthCalledWith(4, 12.5, right, 2);
	});

	it('non-finite values are "-" and do not call formatTooltip', () => {
		const ft = vi.fn(() => 'x');
		for (const v of [NaN, Infinity, -Infinity]) {
			expect(formatTooltipValue(v, left, 0, ft, fl, fr)).toBe('-');
			expect(formatTooltipValue(v, left, 0, undefined, fl, fr)).toBe('-');
		}
		expect(ft).not.toHaveBeenCalled();
	});
});

describe('LineChart wiring (source)', () => {
	const src = LineChartSrc as string;
	it('tooltipRows uses the helper', () => {
		const body = src.slice(src.indexOf('function tooltipRows'));
		expect(body).toContain('formatTooltipValue(');
		expect(body).toContain('formatTooltip');
	});
	it('tick labels and margins never use formatTooltip', () => {
		const uses = src.split('formatTooltip').length - 1;
		const inRows = src.slice(src.indexOf('function tooltipRows')).split('formatTooltip').length - 1;
		const decl = src.slice(0, src.indexOf('function tooltipRows'));
		expect(decl).not.toMatch(/ticks\.map\(formatTooltip|\{formatTooltip\(/);
		expect(inRows).toBeGreaterThan(0);
		expect(uses).toBeGreaterThan(inRows); // prop + destructure live above
		expect(src).toMatch(/\{formatYValue\(tick\)\}/);
		expect(src).toMatch(/\{formatYRightValue\(tick\)\}/);
	});
});
