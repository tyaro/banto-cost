/**
 * The `customers` resource (顧客マスタ, banto-cost P3a): form schema +
 * registration object (docs/recipes/add-resource.md step 7, modelled on
 * the template's removed items.ts). Wire shape: `admin_template_core::customers::Customer` /
 * `CustomerInput` - updates must send back the `rowVersion` that was read
 * (it rides along in the form values from `getOne`), a stale one comes back
 * as a validation error on `rowVersion`. There is no delete: a customer that
 * is no longer used is switched to inactive instead.
 *
 * Labels are lazy getters because the locale is not
 * resolved yet when this module is evaluated).
 */
import type { ResourceDefinition } from '@banto/admin-core';
import type { FormSchema } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';

/** Mirrors `admin_template_core::customers::Customer` (camelCase on the wire). */
export interface Customer {
	id: number;
	name: string;
	active: boolean;
	note: string | null;
	rowVersion: number;
	updatedAt: string;
}

export const customersSchema: FormSchema = {
	fields: [
		{
			name: 'name',
			get label() {
				return m['customers.fieldName']();
			},
			type: 'text',
			required: true,
			min: 1,
			max: 100
		},
		{
			name: 'active',
			get label() {
				return m['customers.fieldActive']();
			},
			type: 'checkbox',
			default: true
		},
		{
			name: 'note',
			get label() {
				return m['customers.fieldNote']();
			},
			type: 'textarea',
			max: 1000
		},
		{
			name: 'updatedAt',
			get label() {
				return m['customers.fieldUpdatedAt']();
			},
			type: 'text',
			readonly: true
		}
	]
};

export const customersResource: ResourceDefinition = {
	name: 'customers',
	get label() {
		return m['customers.resourceLabel']();
	},
	schema: customersSchema,
	capabilities: { list: true, create: true, edit: true, delete: false }
};
