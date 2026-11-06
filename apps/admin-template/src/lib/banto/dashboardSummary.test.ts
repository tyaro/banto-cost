import { describe, expect, it } from 'vitest';
import {
	attentionProjectIds,
	currentAndNextMonth,
	monthOf,
	outlookMonthTotal
} from './dashboardSummary';
import type { OverviewRow, PipelineOverview } from './pipelineAdmin';
import type { OutlookFigures, OutlookView } from './ordersAdmin';

const figures = (total: number): OutlookFigures => ({
	recognized: 0,
	orderedPlan: 0,
	weightedPipeline: total,
	total,
	pendingAddition: 0,
	previousTotal: null,
	difference: null
});

function overviewRow(projectId: number, issues: string[]): OverviewRow {
	return {
		projectId,
		code: `P-${projectId}`,
		name: '架空案件',
		customerName: '見本工業',
		status: 'quoting',
		stage: 'quoting',
		versionNo: 1,
		expectedAmount: 1_000_000,
		probabilityPct: 50,
		weightedAmount: 500_000,
		expectedOrderMonth: '2026-12',
		confirmedOn: null,
		undatedAmount: null,
		issues
	};
}

function overview(rows: OverviewRow[], withoutAdoptedVersion: number[] = []): PipelineOverview {
	return {
		rows,
		totals: {
			activeCount: rows.length,
			total: 0,
			weighted: 0,
			missingAmount: [],
			missingProbability: [],
			excludedCount: 0,
			withoutAdoptedVersion
		},
		byOrderMonth: [],
		byRevenueMonth: [],
		revenueExcluded: []
	};
}

function outlook(partial: Partial<OutlookView>): OutlookView {
	return {
		rows: [],
		totals: figures(0),
		excluded: [],
		revenueIssues: [],
		compared: null,
		snapshot: null,
		...partial
	};
}

describe('currentAndNextMonth', () => {
	it('returns this month and next month as YYYY-MM', () => {
		expect(currentAndNextMonth(new Date(2026, 10, 6))).toEqual({
			current: '2026-11',
			next: '2026-12'
		});
	});

	it('crosses the year end', () => {
		expect(currentAndNextMonth(new Date(2026, 11, 31))).toEqual({
			current: '2026-12',
			next: '2027-01'
		});
	});

	it('does not skip a month from the 31st', () => {
		expect(monthOf(new Date(2027, 0, 31))).toBe('2027-01');
		expect(currentAndNextMonth(new Date(2027, 0, 31)).next).toBe('2027-02');
	});
});

describe('outlookMonthTotal', () => {
	const view = outlook({
		rows: [
			{ month: '2026-11', ...figures(300_000) },
			{ month: null, ...figures(900_000) }
		]
	});

	it('reads the total of the month', () => {
		expect(outlookMonthTotal(view, '2026-11')).toBe(300_000);
	});

	it('is 0 for a month without figures, and never picks the undated row', () => {
		expect(outlookMonthTotal(view, '2026-12')).toBe(0);
	});
});

describe('attentionProjectIds', () => {
	it('is empty without data', () => {
		expect(attentionProjectIds(null, null)).toEqual([]);
	});

	it('counts each project once across the pipeline and the outlook', () => {
		const ids = attentionProjectIds(
			overview([overviewRow(1, []), overviewRow(2, ['amount_missing']), overviewRow(3, [])], [4]),
			outlook({
				revenueIssues: [{ projectId: 2, code: 'P-2', name: '架空案件', issues: ['plan_missing'] }],
				excluded: [{ projectId: 5, code: 'P-5', name: '架空案件' }]
			})
		);
		expect(ids).toEqual([2, 4, 5]);
	});

	it('works with only one of the two sources (the other forbidden or failed)', () => {
		expect(attentionProjectIds(overview([overviewRow(7, ['plan_mismatch'])]), null)).toEqual([7]);
		expect(
			attentionProjectIds(null, outlook({ excluded: [{ projectId: 8, code: 'P-8', name: 'x' }] }))
		).toEqual([8]);
	});
});
