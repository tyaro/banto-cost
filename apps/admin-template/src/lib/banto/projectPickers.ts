/**
 * Choices for the project form's customer / manager fields (banto-cost P3a).
 *
 * - Customers: the active ones from the `customers` resource, plus the
 *   project's current customer even if it has since been made inactive (so
 *   an existing record still shows its value). Reading customers needs admin
 *   or `ViewMasters`; when that is refused, or nothing is registered yet, the
 *   field falls back to a numeric id input instead of an empty select.
 * - Managers: there is no non-admin user list endpoint, so only an admin
 *   session gets a select (through usersAdmin.ts); everyone else enters the
 *   user id, defaulted to their own on create.
 *
 * Every failure here degrades to the numeric input - the server validates
 * both ids either way (spec §5.1).
 */
import { getDataProvider, type Identity } from '@banto/admin-core';
import type { FieldOption } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';
import { isAdmin, type Role } from '#lib/permissions.js';
import { isUsersAdminAvailable, listUsers } from './usersAdmin';
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

async function managerOptions(role: Role): Promise<FieldOption[] | undefined> {
	if (!isAdmin(role) || !isUsersAdminAvailable()) return undefined;
	try {
		const users = await listUsers();
		if (users.length === 0) return undefined;
		return users.map((user) => ({
			value: user.id,
			label: `${user.displayName} (${user.username})`
		}));
	} catch {
		return undefined;
	}
}

export async function loadProjectPickers(
	role: Role,
	currentCustomerId?: number
): Promise<ProjectPickers> {
	const [customers, managers] = await Promise.all([
		customerOptions(currentCustomerId),
		managerOptions(role)
	]);
	return { customers, managers };
}

/** The signed-in user's numeric id, when the identity carries one (create default for the manager). */
export function ownUserId(identity: Identity | null): number | undefined {
	const id = Number(identity?.id);
	return Number.isInteger(id) && id > 0 ? id : undefined;
}
