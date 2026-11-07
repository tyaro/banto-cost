/** banto-cost P4c display rules of the budget section. */
import { describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import { costTypeLabel, hoursToMinutes, minutesToHours, versionLabel } from './budgetFormat';

describe('budgetFormat', () => {
	it('turns planned hours into whole minutes', () => {
		expect(hoursToMinutes('200')).toBe(12_000);
		expect(hoursToMinutes(' 7.5 ')).toBe(450);
		expect(hoursToMinutes('0.25')).toBe(15);
		expect(hoursToMinutes('')).toBeNull();
		expect(hoursToMinutes('-1')).toBeNull();
		expect(hoursToMinutes('1.234')).toBeNull();
		expect(hoursToMinutes('abc')).toBeNull();
	});

	it('shows minutes as hours for the input', () => {
		expect(minutesToHours(12_000)).toBe('200');
		expect(minutesToHours(450)).toBe('7.5');
		expect(minutesToHours(null)).toBe('');
	});

	it('labels cost types and versions', () => {
		expect(costTypeLabel('labor')).toBe(m['budget.costType.labor']());
		expect(costTypeLabel('unknown')).toBe('unknown');
		expect(versionLabel(1)).toBe(m['budget.versionOriginal']({ no: 1 }));
		expect(versionLabel(2)).toBe(m['budget.versionChange']({ no: 2 }));
		expect(versionLabel(null)).toBe(m['budget.draft']());
	});
});
