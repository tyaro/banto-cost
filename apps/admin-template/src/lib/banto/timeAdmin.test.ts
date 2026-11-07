import { describe, expect, it } from 'vitest';
import { countsInTotals, isCorrectable, type TimeEntry } from './timeAdmin';

function entry(over: Partial<TimeEntry>): TimeEntry {
	return {
		id: 1,
		workDate: '2026-11-09',
		userId: 2,
		userName: '架空 太郎',
		projectId: 1,
		projectCode: 'P-001',
		projectName: '架空の案件',
		activityId: null,
		activityName: null,
		phaseId: 1,
		phaseName: '設計',
		minutes: 60,
		description: null,
		reworkKind: null,
		status: 'approved',
		submittedAt: null,
		decidedByName: null,
		decidedAt: null,
		returnReason: null,
		appliedRate: null,
		laborCost: null,
		costMissing: false,
		correctsId: null,
		correctionReason: null,
		replacedById: null,
		correctionPending: false,
		rowVersion: 1,
		updatedAt: '',
		...over
	};
}

describe('time corrections (T11)', () => {
	it('a replaced entry and a returned correction count as nothing', () => {
		expect(countsInTotals(entry({}))).toBe(true);
		expect(countsInTotals(entry({ replacedById: 9 }))).toBe(false);
		expect(countsInTotals(entry({ correctsId: 3, status: 'returned' }))).toBe(false);
		expect(countsInTotals(entry({ correctsId: 3, status: 'submitted' }))).toBe(true);
		expect(countsInTotals(entry({ status: 'returned' }))).toBe(true);
	});

	it('only an approved entry without a newer correction is correctable', () => {
		expect(isCorrectable(entry({}))).toBe(true);
		expect(isCorrectable(entry({ status: 'submitted' }))).toBe(false);
		expect(isCorrectable(entry({ replacedById: 9 }))).toBe(false);
		expect(isCorrectable(entry({ correctionPending: true }))).toBe(false);
		expect(isCorrectable(entry({ correctsId: 3 })), 'an approved correction').toBe(true);
	});
});
