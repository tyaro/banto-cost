import { describe, expect, it } from 'vitest';
import {
	alertCount,
	attentionProjectIds,
	combineCounts,
	currentAndNextMonth,
	dashboardAccess,
	outlookMonthTotal,
	previousMonth,
	withAccess,
	withAccessCombined
} from './dashboardSummary';
import { isForbiddenError } from './costFormat';
import type { Capability } from './capabilitiesAdmin';
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
		expect(currentAndNextMonth('2026-11-06')).toEqual({
			current: '2026-11',
			next: '2026-12'
		});
	});

	it('crosses the year end', () => {
		expect(currentAndNextMonth('2026-12-31')).toEqual({
			current: '2026-12',
			next: '2027-01'
		});
	});

	it('does not skip a month from the 31st', () => {
		expect(currentAndNextMonth('2027-01-31')).toEqual({ current: '2027-01', next: '2027-02' });
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

describe('alertCount', () => {
	const totals = {
		alertCounts: [
			{ alert: 'forecast_loss', count: 2 },
			{ alert: 'low_margin', count: 1 }
		]
	};
	it('reads the projects the overall list counted for the alert', () => {
		expect(alertCount(totals, 'forecast_loss')).toBe(2);
	});
	it('is 0 for an alert no visible project has', () => {
		expect(alertCount(totals, 'forecast_over_budget')).toBe(0);
	});
});

describe('previousMonth', () => {
	it('steps back one month', () => {
		expect(previousMonth('2026-11')).toBe('2026-10');
	});
	it('crosses the year start', () => {
		expect(previousMonth('2027-01')).toBe('2026-12');
	});
});

describe('combineCounts', () => {
	const ok = (value: number) => ({ state: 'ok', value }) as const;
	const loading = { state: 'loading' } as const;
	const failed = (error: unknown) => ({ state: 'error', error }) as const;

	it('sums every list once all are read', () => {
		expect(combineCounts([ok(1), ok(2), ok(0)])).toEqual({
			state: 'ok',
			total: 3,
			missing: 'none'
		});
	});
	it('shows the lists already read while another loads', () => {
		expect(combineCounts([ok(2), loading, ok(1)])).toEqual({
			state: 'ok',
			total: 3,
			missing: 'loading'
		});
	});
	it('keeps the readable lists when one is forbidden, and says a part is missing', () => {
		expect(combineCounts([failed('403'), ok(1), ok(0)])).toEqual({
			state: 'ok',
			total: 1,
			missing: 'failed'
		});
	});
	it('fails with the first error when nothing could be read', () => {
		expect(combineCounts([failed('a'), failed('b')])).toEqual({ state: 'error', error: 'a' });
	});
	it('is loading while nothing is read and a list is still on its way', () => {
		expect(combineCounts([failed('a'), loading])).toEqual({ state: 'loading' });
	});
});

// §8-15: a tile the capabilities rule out reads 権限がありません, never the ¥0 / 0件 of an empty scope.
describe('dashboardAccess', () => {
	const caps = (...c: Capability[]) => new Set<Capability>(c);

	it('changes nothing while the capabilities are unknown', () => {
		expect(dashboardAccess(null)).toEqual({ amounts: true, approvals: true });
	});

	it('amounts need amount.view; approvals need project.manage or finance.close', () => {
		expect(dashboardAccess(caps('time.entry'))).toEqual({ amounts: false, approvals: false });
		expect(dashboardAccess(caps('amount.view', 'project.manage'))).toEqual({
			amounts: true,
			approvals: true
		});
		expect(dashboardAccess(caps('finance.close'))).toEqual({ amounts: false, approvals: true });
	});

	it('a ruled-out source or count is forbidden, an allowed one passes through', () => {
		const ok = { state: 'ok' as const, value: 0 };
		expect(withAccess(ok, true)).toBe(ok);
		const denied = withAccess(ok, false);
		expect(denied.state === 'error' && isForbiddenError(denied.error)).toBe(true);
		const count = combineCounts([ok]);
		expect(withAccessCombined(count, true)).toBe(count);
		const deniedCount = withAccessCombined(count, false);
		expect(deniedCount.state === 'error' && isForbiddenError(deniedCount.error)).toBe(true);
	});
});
