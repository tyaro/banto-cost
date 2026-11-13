import { describe, expect, it } from 'vitest';
import { allows, overridableItems, type ProjectActions } from './projectActions';

const none: ProjectActions = {
	editProject: false,
	editMembers: false,
	editOrder: false,
	decideOrderChange: false,
	recognizeRevenue: false,
	editPipeline: false,
	manageProject: false,
	approveBudget: false,
	adoptForecast: false,
	settle: false,
	enterCost: false,
	editPurchaseOrder: false,
	overrideCalcItems: []
};

describe('allows', () => {
	it('follows the server when its answer is known', () => {
		expect(allows({ ...none, editOrder: true }, true, 'editOrder')).toBe(true);
		expect(allows(none, true, 'editOrder')).toBe(false);
	});

	it('leaves it to the role floor when unknown', () => {
		expect(allows(null, true, 'settle')).toBe(true);
		expect(allows(null, false, 'settle')).toBe(false);
	});

	it('never allows below the role floor', () => {
		expect(allows({ ...none, settle: true }, false, 'settle')).toBe(false);
	});
});

describe('overridableItems', () => {
	it('is the server list, unknown as null, empty below the floor', () => {
		const actions = { ...none, overrideCalcItems: ['forecast_rate'] };
		expect([...(overridableItems(actions, true) ?? [])]).toEqual(['forecast_rate']);
		expect(overridableItems(null, true)).toBeNull();
		expect(overridableItems(actions, false)?.size).toBe(0);
	});
});
