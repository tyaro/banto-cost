/**
 * banto-cost P3a display rules: unset values are 未設定, never 0; the
 * project form only offers the directly settable statuses and freezes an
 * ordered-side one (spec §5.1 / §5.4).
 */
import { describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import { formatPct, formatYen, issueLabel, statusLabel, unmatchedFieldErrors } from './costFormat';
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
		expect(statusField(projectFormSchema({ currentStatus: 'ordered' })).readonly).toBe(true);
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
