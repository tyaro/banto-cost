import { describe, expect, it } from 'vitest';
import {
	GAUGE_END_DEG,
	GAUGE_START_DEG,
	gaugeAngle,
	gaugeColorVar,
	gaugeRatio
} from '../src/core/gauge';

describe('gaugeRatio', () => {
	it('maps min to 0 and max to 1', () => {
		expect(gaugeRatio(0, 0, 100)).toBe(0);
		expect(gaugeRatio(100, 0, 100)).toBe(1);
	});

	it('is linear in between', () => {
		expect(gaugeRatio(25, 0, 100)).toBeCloseTo(0.25);
		expect(gaugeRatio(75, 0, 100)).toBeCloseTo(0.75);
	});

	it('clamps a value below min to 0', () => {
		expect(gaugeRatio(-50, 0, 100)).toBe(0);
	});

	it('clamps a value above max to 1', () => {
		expect(gaugeRatio(500, 0, 100)).toBe(1);
	});

	it('returns 0 for a degenerate/inverted range (max <= min) instead of dividing by zero', () => {
		expect(gaugeRatio(5, 10, 10)).toBe(0);
		expect(gaugeRatio(5, 10, 0)).toBe(0);
	});

	it('treats a non-finite value as the range floor rather than propagating NaN', () => {
		expect(gaugeRatio(NaN, 0, 100)).toBe(0);
	});
});

describe('gaugeAngle', () => {
	it('starts at GAUGE_START_DEG (135) when value <= min', () => {
		expect(gaugeAngle(0, 0, 100)).toBe(GAUGE_START_DEG);
		expect(gaugeAngle(-10, 0, 100)).toBe(GAUGE_START_DEG);
	});

	it('ends at GAUGE_END_DEG (405) when value >= max', () => {
		expect(gaugeAngle(100, 0, 100)).toBe(GAUGE_END_DEG);
		expect(gaugeAngle(200, 0, 100)).toBe(GAUGE_END_DEG);
	});

	it('is the midpoint (270) for the midpoint value', () => {
		expect(gaugeAngle(50, 0, 100)).toBeCloseTo(270);
	});
});

describe('gaugeColorVar', () => {
	it('defaults to the primary theme color with no thresholds', () => {
		expect(gaugeColorVar(999)).toBe('var(--banto-primary)');
	});

	it('stays primary below the warning threshold', () => {
		expect(gaugeColorVar(49, { warning: 50, danger: 90 })).toBe('var(--banto-primary)');
	});

	it('switches to warning exactly AT the warning threshold ("crossed above")', () => {
		expect(gaugeColorVar(50, { warning: 50, danger: 90 })).toBe('var(--banto-warning)');
	});

	it('switches to danger exactly at the danger threshold', () => {
		expect(gaugeColorVar(90, { warning: 50, danger: 90 })).toBe('var(--banto-danger)');
	});

	it('danger wins precedence when both thresholds are crossed', () => {
		expect(gaugeColorVar(95, { warning: 50, danger: 90 })).toBe('var(--banto-danger)');
	});

	it('lower thresholds match on value <= threshold (warningLow / dangerLow)', () => {
		const th = { warningLow: 20, dangerLow: 10 };
		expect(gaugeColorVar(21, th)).toBe('var(--banto-primary)');
		expect(gaugeColorVar(20, th)).toBe('var(--banto-warning)');
		expect(gaugeColorVar(11, th)).toBe('var(--banto-warning)');
		expect(gaugeColorVar(10, th)).toBe('var(--banto-danger)');
		expect(gaugeColorVar(-5, th)).toBe('var(--banto-danger)');
	});

	it('combines lower and upper thresholds; the upper ones are unchanged', () => {
		const th = { warning: 80, danger: 90, warningLow: 20, dangerLow: 10 };
		expect(gaugeColorVar(50, th)).toBe('var(--banto-primary)');
		expect(gaugeColorVar(85, th)).toBe('var(--banto-warning)');
		expect(gaugeColorVar(95, th)).toBe('var(--banto-danger)');
		expect(gaugeColorVar(15, th)).toBe('var(--banto-warning)');
	});

	it('a non-finite value (NaN, i.e. no reading) stays primary under any thresholds', () => {
		const th = { warning: 80, danger: 90, warningLow: 20, dangerLow: 10 };
		expect(gaugeColorVar(NaN, th)).toBe('var(--banto-primary)');
	});

	it('no value (null → NaN) yields angle at the range floor', () => {
		expect(gaugeAngle(NaN, 0, 100)).toBe(GAUGE_START_DEG);
	});

	it('supports a warning-only threshold set (no danger)', () => {
		expect(gaugeColorVar(1000, { warning: 50 })).toBe('var(--banto-warning)');
	});
});
