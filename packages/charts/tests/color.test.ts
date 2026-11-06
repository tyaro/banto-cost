import { describe, expect, it } from 'vitest';
import { SEQ_RAMP, sequentialColor, seriesColorVar } from '../src/core/color';

describe('seriesColorVar', () => {
	it('maps series index 0..7 to slots 1..8 in fixed order', () => {
		for (let i = 0; i < 8; i++) {
			expect(seriesColorVar(i)).toBe(`var(--banto-chart-${i + 1})`);
		}
	});

	it('clamps overflow (index >= 8) to slot 8 instead of cycling back to slot 1', () => {
		expect(seriesColorVar(8)).toBe('var(--banto-chart-8)');
		expect(seriesColorVar(20)).toBe('var(--banto-chart-8)');
	});
});

describe('sequentialColor', () => {
	it("maps the minimum to the ramp's first (lightest) step", () => {
		expect(sequentialColor(0, 0, 100)).toBe(SEQ_RAMP[0]);
	});

	it("maps the maximum to the ramp's last (darkest) step", () => {
		expect(sequentialColor(100, 0, 100)).toBe(SEQ_RAMP[SEQ_RAMP.length - 1]);
	});

	it('bins linearly across the domain', () => {
		// 7 steps over [0, 70]: value 10 sits in bin 1 (10/70 * 7 = 1).
		expect(sequentialColor(10, 0, 70)).toBe(SEQ_RAMP[1]);
		expect(sequentialColor(35, 0, 70)).toBe(SEQ_RAMP[3]);
	});

	it('degenerate min === max maps to the middle step, not the lightest end', () => {
		expect(sequentialColor(5, 5, 5)).toBe(SEQ_RAMP[Math.floor(SEQ_RAMP.length / 2)]);
	});

	it('clamps out-of-domain values instead of extrapolating past the ramp', () => {
		expect(sequentialColor(-50, 0, 100)).toBe(SEQ_RAMP[0]);
		expect(sequentialColor(500, 0, 100)).toBe(SEQ_RAMP[SEQ_RAMP.length - 1]);
	});

	it('accepts a caller-supplied ramp of a different length', () => {
		const ramp = ['#111', '#222', '#333'];
		expect(sequentialColor(0, 0, 10, ramp)).toBe('#111');
		expect(sequentialColor(10, 0, 10, ramp)).toBe('#333');
		expect(sequentialColor(5, 5, 5, ramp)).toBe('#222');
	});
});
