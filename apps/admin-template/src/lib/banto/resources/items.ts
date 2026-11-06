/**
 * The `items` demo resource definition (spec §3): form schema + resource
 * registration object. **This is the file app authors replace** when
 * swapping the demo resource for their own (docs/recipes/add-resource.md
 * step 7) - copy it to `resources/<yours>.ts`, rewrite, register in
 * `resources/index.ts`, and delete this one when done.
 */
import type { ResourceDefinition } from '@banto/admin-core';
import type { FormSchema } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';

// Rust's ItemInput.price/.stock (apps/admin-template/core/src/items.rs) are
// `i64`, so a fractional value must be rejected client-side too (not just
// bounds-checked) - otherwise it passes here and only fails after a round
// trip to the real backend. `validateField` (packages/forms/src/
// validate.ts) runs required, then min/max, then this `validate` in that
// order, so the built-in required/min/max checks still run first; this only
// adds an extra integer check on top.
//
// i18n (ADR-0005, PR-B2/B2b): the custom validator resolves its message lazily
// at call time (render/validation), so it is locale-correct. The resource
// `label` and field `label`s use the SAME lazy trick — a `get label()` getter
// (typed `string`, so the package contracts are untouched, conventions §4/§5)
// instead of an eager string literal. This module is evaluated at app startup
// (initBanto) BEFORE locale.ts registers the `custom-banto` client strategy, so
// a module-eval `m['…']()` would freeze to the English `baseLocale`; a getter
// defers the `m['…']()` call to when the label is actually read (grid/form
// render), by which point the locale is resolved. The registry stores the
// resource object by reference (packages/admin-core/src/registry.svelte.ts) and
// `columnsFromSchema`/`BantoForm` read `.label` at render, so the getter fires
// locale-ready and stays reactive to the active locale.
const integerValidate = (value: unknown): string | null =>
	Number.isInteger(Number(value)) ? null : m['validation.integer']();

export const itemsSchema: FormSchema = {
	fields: [
		{
			name: 'name',
			get label() {
				return m['items.fieldName']();
			},
			type: 'text',
			required: true,
			min: 1,
			max: 40
		},
		{
			name: 'price',
			get label() {
				return m['items.fieldPrice']();
			},
			type: 'number',
			required: true,
			min: 0,
			max: 99999,
			validate: integerValidate
		},
		{
			name: 'stock',
			get label() {
				return m['items.fieldStock']();
			},
			type: 'number',
			required: true,
			min: 0,
			validate: integerValidate
		},
		{
			name: 'updatedAt',
			get label() {
				return m['items.fieldUpdatedAt']();
			},
			type: 'date',
			readonly: true
		}
	]
};

export const itemsResource: ResourceDefinition = {
	name: 'items',
	get label() {
		return m['items.resourceLabel']();
	},
	icon: '📦',
	schema: itemsSchema,
	capabilities: { list: true, create: true, edit: true, delete: true }
};
