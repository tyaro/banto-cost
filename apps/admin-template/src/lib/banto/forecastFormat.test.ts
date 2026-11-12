import { describe, expect, it } from 'vitest';
import {
	alertLabel,
	formatPermille,
	isSevereAlert,
	ledgerReasonLabel,
	ledgerRecordLabel,
	updateReasonLabel
} from './forecastFormat';

describe('forecastFormat', () => {
	it('shows permille as a one-decimal percentage, and null as not computable', () => {
		expect(formatPermille(275)).toBe('27.5%');
		expect(formatPermille(250)).toBe('25.0%');
		expect(formatPermille(-5)).toBe('-0.5%');
		expect(formatPermille(0)).toBe('0.0%');
		expect(formatPermille(null)).not.toBe('0.0%');
		expect(formatPermille(undefined)).toBe(formatPermille(null));
	});

	it('labels known alerts and reasons, and keeps unknown codes', () => {
		expect(alertLabel('forecast_loss')).not.toBe('forecast_loss');
		expect(alertLabel('something_new')).toBe('something_new');
		expect(updateReasonLabel('actual_after_base')).not.toBe('actual_after_base');
		expect(isSevereAlert('forecast_over_budget')).toBe(true);
		expect(isSevereAlert('unapproved')).toBe(false);
	});

	it('labels a record left out of the direct-cost ledger (T39)', () => {
		expect(alertLabel('ledger_review')).not.toBe('ledger_review');
		expect(isSevereAlert('ledger_review')).toBe(true);
		const direct = ledgerRecordLabel({ source: 'direct_cost', id: 12 });
		const fixed = ledgerRecordLabel({ source: 'fixed_cost', id: 12 });
		expect(direct).toContain('12');
		expect(fixed).toContain('12');
		expect(direct).not.toBe(fixed);
		const unreadable = ledgerReasonLabel({ code: 'unreadable', column: 'booked_on' });
		expect(unreadable).not.toContain('booked_on');
		expect(ledgerReasonLabel({ code: 'related', column: null })).not.toBe('related');
		expect(ledgerReasonLabel({ code: 'something_new', column: null })).toBe('something_new');
	});
});
