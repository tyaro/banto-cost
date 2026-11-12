/**
 * banto-cost P3a display rules: unset values are 未設定, never 0; the
 * project form only offers the directly settable statuses, keeps an ordered
 * project on the ordered side and freezes a settled one (spec §5.1 / §5.4).
 */
import { describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import {
	calcItemLabel,
	formatCalcValue,
	formatPct,
	formatSignedYen,
	formatYen,
	issueLabel,
	statusLabel,
	todayIso,
	unmatchedFieldErrors
} from './costFormat';
import { isOrderedStatus, projectFormSchema, SETTABLE_STATUSES } from './resources/projects';

describe('costFormat', () => {
	it('shows null as unset and 0 as a real zero', () => {
		expect(formatYen(null)).toBe(m['cost.unset']());
		expect(formatPct(null)).toBe(m['cost.unset']());
		expect(formatYen(0)).toBe('¥0');
		expect(formatPct(0)).toBe('0%');
		expect(formatYen(3000000)).toContain('3');
	});

	it('labels known codes and passes unknown ones through', () => {
		expect(statusLabel('lead')).toBe(m['projects.status.lead']());
		expect(statusLabel('mystery')).toBe('mystery');
		expect(issueLabel('plan_mismatch')).toBe(m['pipeline.issue.planMismatch']());
	});

	it('keeps server errors no rendered field owns', () => {
		expect(
			unmatchedFieldErrors(
				['name'],
				[
					{ field: 'name', message: 'a' },
					{ field: 'rowVersion', message: 'b' }
				]
			)
		).toEqual(['b']);
	});
});

describe('formatSignedYen', () => {
	it('signs the amount and keeps null as unset', () => {
		expect(formatSignedYen(300000)).toBe('+¥300,000');
		expect(formatSignedYen(-100000)).toBe('-¥100,000');
		expect(formatSignedYen(0)).toBe('¥0');
		expect(formatSignedYen(null)).not.toBe('¥0');
	});
});

describe('projectFormSchema', () => {
	const statusField = (schema: ReturnType<typeof projectFormSchema>) =>
		schema.fields.find((field) => field.name === 'status')!;

	it('offers only the directly settable statuses', () => {
		const values = statusField(projectFormSchema()).options!.map((option) => option.value);
		expect(values).toEqual([...SETTABLE_STATUSES]);
	});

	it('makes an ordered-side status read-only', () => {
		expect(isOrderedStatus('in_progress')).toBe(true);
		expect(isOrderedStatus('on_hold')).toBe(false);
		// An ordered project moves only on the ordered side; settled is read-only.
		const ordered = statusField(projectFormSchema({ currentStatus: 'ordered' }));
		expect(ordered.readonly).toBeFalsy();
		expect(ordered.options!.map((option) => option.value)).toEqual([
			'ordered',
			'in_progress',
			'work_done'
		]);
		expect(statusField(projectFormSchema({ currentStatus: 'settled' })).readonly).toBe(true);
		expect(statusField(projectFormSchema({ currentStatus: 'lead' })).readonly).toBeFalsy();
	});

	it('turns the id inputs into selects only when choices are given', () => {
		const plain = projectFormSchema();
		expect(plain.fields.find((field) => field.name === 'customerId')!.type).toBe('number');
		const picked = projectFormSchema({ customers: [{ value: 1, label: 'Example Co.' }] });
		const customer = picked.fields.find((field) => field.name === 'customerId')!;
		expect(customer.type).toBe('select');
		expect(customer.label).toBe(m['projects.fieldCustomer']());
	});
});

describe('calc basis display (P4a)', () => {
	it('shows an unset value as unset, never as 0', () => {
		expect(formatCalcValue(null, 'yen_per_hour')).toBe(m['cost.unset']());
		expect(formatCalcValue(5000, 'yen_per_hour')).toBe(
			m['calcBasis.unit.yenPerHour']({ value: (5000).toLocaleString() })
		);
		expect(formatCalcValue(0, 'percent')).toBe('0%');
	});

	it('shows whole hours next to minutes', () => {
		expect(formatCalcValue(480, 'minutes')).toBe(
			m['calcBasis.unit.minutesHours']({ value: (480).toLocaleString(), hours: '8' })
		);
		expect(formatCalcValue(15, 'minutes')).toBe(m['calcBasis.unit.minutes']({ value: '15' }));
	});

	it('labels seeded items and falls back to the stored label', () => {
		expect(calcItemLabel({ key: 'emp_rate', label: 'x' })).toBe(m['calcBasis.item.empRate']());
		expect(calcItemLabel({ key: 'added_later', label: '後から追加' })).toBe('後から追加');
	});

	it('formats the local date as YYYY-MM-DD before the calendar is loaded', () => {
		expect(todayIso(new Date(2026, 10, 6, 23, 59))).toBe('2026-11-06');
	});
});
