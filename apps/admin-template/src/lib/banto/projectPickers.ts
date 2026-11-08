/**
 * Choices for the project form's customer / manager fields (banto-cost P3a).
 *
 * - Customers: the active ones from the `customers` resource, plus the
 *   project's current customer even if it has since been made inactive (so
 *   an existing record still shows its value). Reading customers needs admin
 *   or `ViewMasters`; when that is refused, or nothing is registered yet, the
 *   field falls back to a numeric id input instead of an empty select.
 * - Managers: every account's display name from the business user-name list
 *   (userNames.ts, `ViewMasters` or the admin role - the same right as the
 *   customers). When that is refused (no company grant) or in demo mode the
 *   field falls back to the numeric user id, defaulted to one's own on create.
 *
 * Every failure here degrades to the numeric input - the server validates
 * both ids either way (spec §5.1).
 */
import { getDataProvider, type Identity } from '@banto/admin-core';
import type { FieldOption } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';
import { listUserNames, userNameOptions } from './userNames';
import type { Customer } from './resources/customers';

export interface ProjectPickers {
	customers?: FieldOption[];
	managers?: FieldOption[];
}

async function customerOptions(currentId?: number): Promise<FieldOption[] | undefined> {
	try {
		const result = await getDataProvider().getList<Customer>('customers', {
			sort: [{ field: 'name', direction: 'asc' }],
			filters: [],
			pagination: { offset: 0, limit: 5_000 }
		});
		const options = result.rows
			.filter((customer) => customer.active || customer.id === currentId)
			.map((customer) => ({
				value: customer.id,
				label: customer.active
					? customer.name
					: m['projects.inactiveCustomer']({ name: customer.name })
			}));
		return options.length > 0 ? options : undefined;
	} catch {
		return undefined;
	}
}

async function managerOptions(): Promise<FieldOption[] | undefined> {
	try {
		const names = await listUserNames();
		return names.length > 0 ? userNameOptions(names) : undefined;
	} catch {
		return undefined;
	}
}

export async function loadProjectPickers(currentCustomerId?: number): Promise<ProjectPickers> {
	const [customers, managers] = await Promise.all([
		customerOptions(currentCustomerId),
		managerOptions()
	]);
	return { customers, managers };
}

/** The signed-in user's numeric id, when the identity carries one (create default for the manager). */
export function ownUserId(identity: Identity | null): number | undefined {
	const id = Number(identity?.id);
	return Number.isInteger(id) && id > 0 ? id : undefined;
}
