/**
 * The `projects` resource (案件台帳, spec §5.1, banto-cost P3a): form schema +
 * registration object (docs/recipes/add-resource.md step 7, modelled on
 * the template's removed items.ts). Wire shape: `admin_template_core::projects::Project` /
 * `ProjectInput`; updates send back the `rowVersion` that was read. No delete.
 *
 * Status rule (spec §5.1 / §5.5, `ProjectStatus::can_edit_to`): before the order
 * only the pre-order statuses and 失注・中止・保留 may be chosen here - the
 * ordered side is reached through order conversion (P3b, OrderSection.svelte).
 * An ordered project moves only between 受注・進行中・作業完了; 精算完了 comes
 * from the close-out check (T17) and is read-only. The registered schema lists
 * EVERY status so the list grid can label any row; the form pages call
 * `projectFormSchema()` to get the narrowed status field and an optional
 * customer / manager picker.
 *
 * Labels are lazy getters for the same reason as customers.ts.
 */
import type { ResourceDefinition } from '@banto/admin-core';
import type { FieldDef, FieldOption, FormSchema } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';
import { statusLabel } from '../costFormat';

/** Mirrors `admin_template_core::projects::Project` (camelCase on the wire). */
export interface Project {
	id: number;
	code: string;
	name: string;
	customerId: number;
	customerName: string;
	managerUserId: number;
	managerName: string;
	status: string;
	plannedStart: string | null;
	plannedEnd: string | null;
	orderNo: string | null;
	department: string | null;
	note: string | null;
	rowVersion: number;
	updatedAt: string;
}

export const PROJECT_STATUSES = [
	'lead',
	'quoting',
	'negotiating',
	'ordered',
	'in_progress',
	'work_done',
	'settled',
	'lost',
	'cancelled',
	'on_hold'
] as const;

/** Statuses the ledger form may set directly (the rest come from order conversion). */
export const SETTABLE_STATUSES: readonly string[] = [
	'lead',
	'quoting',
	'negotiating',
	'lost',
	'cancelled',
	'on_hold'
];

/** Statuses an ordered project may move between on the ledger form. */
export const ORDERED_EDITABLE_STATUSES: readonly string[] = ['ordered', 'in_progress', 'work_done'];

/** Ordered side (受注〜精算完了): no pipeline versions. */
export function isOrderedStatus(status: string): boolean {
	return (
		!SETTABLE_STATUSES.includes(status) && (PROJECT_STATUSES as readonly string[]).includes(status)
	);
}

function statusOptions(statuses: readonly string[]): FieldOption[] {
	// Lazy labels: `FieldOption.label` is read at render, after locale setup.
	return statuses.map((value) => ({
		value,
		get label() {
			return statusLabel(value);
		}
	}));
}

const integerValidate = (value: unknown): string | null =>
	value === '' || value === null || value === undefined || Number.isInteger(Number(value))
		? null
		: m['validation.integer']();

export const projectsSchema: FormSchema = {
	fields: [
		{
			name: 'code',
			get label() {
				return m['projects.fieldCode']();
			},
			type: 'text',
			required: true,
			min: 1,
			max: 30
		},
		{
			name: 'name',
			get label() {
				return m['projects.fieldName']();
			},
			type: 'text',
			required: true,
			min: 1,
			max: 100
		},
		{
			name: 'customerId',
			get label() {
				return m['projects.fieldCustomerId']();
			},
			type: 'number',
			required: true,
			min: 1,
			validate: integerValidate
		},
		{
			name: 'managerUserId',
			get label() {
				return m['projects.fieldManagerUserId']();
			},
			type: 'number',
			required: true,
			min: 1,
			validate: integerValidate
		},
		{
			name: 'status',
			get label() {
				return m['projects.fieldStatus']();
			},
			type: 'select',
			required: true,
			default: 'lead',
			options: statusOptions(PROJECT_STATUSES)
		},
		{
			name: 'plannedStart',
			get label() {
				return m['projects.fieldPlannedStart']();
			},
			type: 'date'
		},
		{
			name: 'plannedEnd',
			get label() {
				return m['projects.fieldPlannedEnd']();
			},
			type: 'date'
		},
		{
			name: 'orderNo',
			get label() {
				return m['projects.fieldOrderNo']();
			},
			type: 'text',
			max: 30
		},
		{
			name: 'department',
			get label() {
				return m['projects.fieldDepartment']();
			},
			type: 'text',
			max: 100
		},
		{
			name: 'note',
			get label() {
				return m['projects.fieldNote']();
			},
			type: 'textarea',
			max: 1000
		}
	]
};

export interface ProjectFormOptions {
	/** The stored status when editing; an ordered-side one narrows the field to the ordered side. */
	currentStatus?: string;
	/** Customers to pick from (active ones, plus the current one). Omitted = numeric id input. */
	customers?: FieldOption[];
	/** Users to pick the manager from (admin sessions only). Omitted = numeric id input. */
	managers?: FieldOption[];
}

/**
 * Copy `field` with `overrides` applied, keeping property getters as getters
 * (a plain `{ ...field }` would evaluate the lazy `label` once and freeze it
 * to the locale active at that moment).
 */
function extend(field: FieldDef, overrides: Partial<FieldDef>): FieldDef {
	return Object.defineProperties(
		{},
		{
			...Object.getOwnPropertyDescriptors(field),
			...Object.getOwnPropertyDescriptors(overrides)
		}
	) as FieldDef;
}

/** The schema the create / edit pages render (see the module comment). */
export function projectFormSchema(options: ProjectFormOptions = {}): FormSchema {
	const ordered = options.currentStatus !== undefined && isOrderedStatus(options.currentStatus);
	return {
		fields: projectsSchema.fields.map((field): FieldDef => {
			if (field.name === 'status') {
				if (ordered && options.currentStatus === 'settled') {
					return extend(field, { readonly: true });
				}
				if (ordered) return extend(field, { options: statusOptions(ORDERED_EDITABLE_STATUSES) });
				return extend(field, { options: statusOptions(SETTABLE_STATUSES) });
			}
			if (field.name === 'customerId' && options.customers) {
				return extend(field, {
					type: 'select',
					options: options.customers,
					validate: undefined,
					get label() {
						return m['projects.fieldCustomer']();
					}
				});
			}
			if (field.name === 'managerUserId' && options.managers) {
				return extend(field, {
					type: 'select',
					options: options.managers,
					validate: undefined,
					get label() {
						return m['projects.fieldManager']();
					}
				});
			}
			return field;
		})
	};
}

export const projectsResource: ResourceDefinition = {
	name: 'projects',
	get label() {
		return m['projects.resourceLabel']();
	},
	schema: projectsSchema,
	capabilities: { list: true, create: true, edit: true, delete: false }
};
