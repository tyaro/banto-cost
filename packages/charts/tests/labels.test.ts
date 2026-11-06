import { describe, expect, it } from 'vitest';
import {
	estimateLabelWidth,
	leftMarginFor,
	leftMarginForTicks,
	rightMarginForTicks,
	rightMarginForLastTick
} from '../src/core/labels';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import LineChartSrc from '../src/LineChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import StackedAreaChartSrc from '../src/StackedAreaChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import ComboChartSrc from '../src/ComboChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import ScatterChartSrc from '../src/ScatterChart.svelte?raw';

describe('estimateLabelWidth', () => {
	it('estimates CJK characters as ~13px each at the 11px tick font', () => {
		// 8 fullwidth kana - the widest real category in the demo data
		// (アップルジュース) must come out around 8 * 13px.
		const width = estimateLabelWidth('アップルジュース', 11);
		expect(width).toBeGreaterThan(96);
		expect(width).toBeLessThan(112);
	});

	it('estimates ASCII narrower than CJK', () => {
		expect(estimateLabelWidth('12345678', 11)).toBeLessThan(
			estimateLabelWidth('アップルジュース', 11)
		);
	});

	it('scales with font size', () => {
		expect(estimateLabelWidth('あ', 22)).toBeCloseTo(estimateLabelWidth('あ', 11) * 2);
	});

	it('returns 0 for empty text', () => {
		expect(estimateLabelWidth('', 11)).toBe(0);
	});
});

describe('leftMarginFor', () => {
	it('fits the longest label plus the gap', () => {
		const margin = leftMarginFor(['緑茶', 'アップルジュース'], { fontSize: 11, gap: 8 });
		expect(margin).toBeGreaterThanOrEqual(
			Math.round(estimateLabelWidth('アップルジュース', 11) + 8)
		);
		expect(margin).toBeLessThanOrEqual(140);
	});

	it('clamps to the minimum for short labels', () => {
		expect(leftMarginFor(['A'], { min: 48 })).toBe(48);
	});

	it('clamps to the maximum for pathological labels', () => {
		expect(leftMarginFor(['あ'.repeat(50)], { max: 140 })).toBe(140);
	});

	it('returns the minimum for an empty label list', () => {
		expect(leftMarginFor([])).toBe(48);
	});
});

describe('rightMarginForLastTick', () => {
	it('reserves half the (middle-anchored) label width plus pad', () => {
		const margin = rightMarginForLastTick('1,000,000', { fontSize: 11, gap: 4 });
		expect(margin).toBeGreaterThanOrEqual(Math.round(estimateLabelWidth('1,000,000', 11) / 2));
	});

	it('never shrinks below the minimum', () => {
		expect(rightMarginForLastTick('1', { min: 16 })).toBe(16);
	});
});

describe('leftMarginForTicks', () => {
	it('keeps the base margin when the labels already fit', () => {
		expect(leftMarginForTicks(['0', '50', '100'], 48)).toBe(48);
		expect(leftMarginForTicks(['1,000', '2,000'], 48)).toBe(48);
	});

	it('expands for long labels such as 800,000,000', () => {
		const left = leftMarginForTicks(['0', '400,000,000', '800,000,000'], 48);
		expect(left).toBeGreaterThan(48);
		// the label (estimated) plus the 8px axis gap must fit
		expect(left).toBeGreaterThanOrEqual(estimateLabelWidth('800,000,000') + 8);
	});

	it('accounts for the minus sign of negative numbers', () => {
		const positive = leftMarginForTicks(['100,000,000'], 0);
		const negative = leftMarginForTicks(['-100,000,000'], 0);
		expect(negative).toBeGreaterThan(positive);
	});

	it('measures the formatter output, not the raw number', () => {
		const formatted = [0, 800_000_000].map((n) => (n === 0 ? '0' : `${n / 1e6}M`));
		expect(leftMarginForTicks(formatted, 48)).toBe(48);
		expect(
			leftMarginForTicks(
				[0, 800_000_000].map((n) => n.toLocaleString()),
				48
			)
		).toBeGreaterThan(48);
	});

	it('treats an explicit caller margin as the minimum', () => {
		expect(leftMarginForTicks(['0', '10'], 80)).toBe(80);
		expect(leftMarginForTicks(['800,000,000'], 20)).toBeGreaterThan(20);
	});

	it('returns the base margin for no labels', () => {
		expect(leftMarginForTicks([], 48)).toBe(48);
	});

	// Cap: a pathological label must not squeeze the plot area to zero.
	it('caps a huge label (1e100 via the default formatter) so the plot keeps a width', () => {
		const huge = [0, 1e100].map((n) => n.toLocaleString());
		expect(estimateLabelWidth(huge[1])).toBeGreaterThan(500); // uncapped would be ~900px
		const totalWidth = 380;
		const left = leftMarginForTicks(huge, 48, { totalWidth });
		expect(left).toBeLessThanOrEqual(Math.floor(totalWidth * 0.4));
		expect(left).toBeGreaterThanOrEqual(48);
		const right = 16;
		expect(totalWidth - left - right).toBeGreaterThan(0);
	});

	it('caps at the absolute max when the width is unknown or large', () => {
		const huge = ['1'.repeat(130)];
		expect(leftMarginForTicks(huge, 48)).toBe(140);
		expect(leftMarginForTicks(huge, 48, { totalWidth: 2000 })).toBe(140);
	});

	it('never goes below the base margin, even when the cap would be smaller', () => {
		expect(leftMarginForTicks(['1'.repeat(130)], 80, { totalWidth: 100 })).toBe(80);
		expect(leftMarginForTicks(['0'], 200, { totalWidth: 100 })).toBe(200);
	});

	it('leaves normal cases unchanged by the cap', () => {
		expect(leftMarginForTicks(['0', '50', '100'], 48, { totalWidth: 380 })).toBe(48);
		const labels = ['0', '400,000,000', '800,000,000'];
		expect(leftMarginForTicks(labels, 48, { totalWidth: 380 })).toBe(
			leftMarginForTicks(labels, 48)
		);
	});
});

const SOURCES: Record<string, string> = {
	LineChart: LineChartSrc,
	StackedAreaChart: StackedAreaChartSrc,
	ComboChart: ComboChartSrc,
	ScatterChart: ScatterChartSrc
};

describe('narrow containers (150px) keep a plot area', () => {
	const long = ['1'.repeat(30)];
	const right = 16;

	it('left margin: 30-char labels at width 150 leave innerWidth > 0', () => {
		const left = leftMarginForTicks(long, 48, { totalWidth: 150 });
		expect(left).toBeLessThanOrEqual(Math.floor(150 * 0.4));
		expect(150 - left - right).toBeGreaterThan(0);
		// without the width the absolute cap alone (140px) would collapse the plot
		expect(150 - leftMarginForTicks(long, 48) - right).toBeLessThanOrEqual(0);
	});

	it('right margin: capped by the same policy, never below the base', () => {
		expect(rightMarginForTicks(['0', '100'], 40, { totalWidth: 380 })).toBe(40);
		const r = rightMarginForTicks(long, 16, { totalWidth: 150 });
		expect(r).toBeLessThanOrEqual(60);
		expect(r).toBeGreaterThanOrEqual(16);
		expect(rightMarginForTicks(['1'.repeat(130)], 16)).toBe(140);
		expect(rightMarginForTicks(['1'.repeat(130)], 80, { totalWidth: 100 })).toBe(80);
	});

	it('right margin keeps the previous widest + 12 rule while it fits', () => {
		const labels = ['0.00MPa', '1.20MPa'];
		expect(rightMarginForTicks(labels, 16, { totalWidth: 600 })).toBe(
			Math.max(16, Math.ceil(estimateLabelWidth('1.20MPa') + 12))
		);
	});

	// No component-mount test infra in this package: guard the wiring by source
	// so each chart keeps passing the measured width into the margin policy.
	it.each(['LineChart', 'StackedAreaChart', 'ComboChart', 'ScatterChart'])(
		'%s passes the measured width to the left margin',
		(name) => {
			const src: string = SOURCES[name];
			expect(src).toMatch(/leftMarginForTicks\([\s\S]*?totalWidth: plotWidth/);
			expect(src).toContain('bind:width={plotWidth}');
		}
	);

	it('LineChart passes the measured width to the right margin', () => {
		const src: string = LineChartSrc;
		expect(src).toMatch(/rightMarginForTicks\([\s\S]*?totalWidth: plotWidth/);
	});
});
