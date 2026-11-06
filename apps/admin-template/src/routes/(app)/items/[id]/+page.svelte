<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import {
		createFormResource,
		currentSessionScope,
		getResource,
		isProviderError,
		noteLastEditedRecord,
		saveLastOpenedId
	} from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';

	const resource = getResource('items');
	const schema = resource.schema as FormSchema;

	// Spec M10 RBAC: `viewer` can still open this page to look at a record
	// (row-click navigation to it is allowed, per the items list page), but
	// may not save or delete. `BantoForm`'s `submitting` prop disables every
	// field AND the submit button together (there is no separate "read-only"
	// prop) - reusing it here for `!canWrite` doubles as "make the whole form
	// read-only", which is a fine RBAC outcome, not just an incidental side
	// effect: a viewer can't usefully edit fields it can never save anyway.
	const canWrite = $derived(canWriteResources(sessionStore.role));
	// SvelteKit itself REUSES this component between two [id] values (a move
	// from items/1 to items/2 only updates `page.params`; Issue #290), so the
	// guarantee that reading the param once at setup time is enough comes from
	// the (app) layout, which keys the page on its route params and so builds
	// a fresh instance per [id] value. Do not move this page out from under
	// that layout without re-checking it (e2e smoke scenario 3f).
	//
	// Rust's items_get/items_update/items_delete commands declare `id: i64`
	// (apps/admin-template/src-tauri/src/lib.rs); Tauri's serde deserializer
	// does NOT coerce a JSON string into a number, so the raw route param
	// (always a string) must be converted to a real `number` before it ever
	// reaches createFormResource/DataProvider. A param that isn't a valid
	// integer (non-numeric, empty, fractional, ...) can never be a real item
	// id, so it's treated as not-found immediately - createFormResource/load
	// is never even called for it.
	const rawId = page.params.id ?? '';
	const parsedId = Number(rawId);
	const idValid = rawId !== '' && Number.isInteger(parsedId);

	// Issue #215: mark this as the row the items list should highlight once
	// the user goes back. Done HERE, not from the list's row-click handler,
	// because the list's "開く" cell is a plain link and navigates via its
	// own `href` without ever running the grid's `onRowClick` callback once
	// it has editable columns (`admin-core`'s `saveLastOpenedId` doc comment
	// has the full reasoning) - this detail page is the one place every way
	// of getting here (a grid link click, a double-click on a read-only
	// cell, a pasted URL, the browser back button) actually passes through.
	// Set unconditionally for any syntactically valid id, even before
	// `formResource.load()` confirms the record still exists - a stale
	// marker pointing at a since-deleted row is harmless (no row to
	// highlight).
	//
	// Issue #215/#255 (4th review): `scope` is the session this page was
	// built for - the marker is saved for its owner only, and the save
	// handler below passes the SAME scope, so a response that arrives after
	// the session ended (or ended and began again) writes nothing.
	const scope = currentSessionScope();
	if (idValid) saveLastOpenedId(scope, resource.name, parsedId);

	const formResource = idValid ? createFormResource(resource.name, parsedId) : null;
	// i18n layer ② (ADR-0005): inject Paraglide-backed validation messages.
	let store = $state(createFormStore(schema, undefined, formValidationMessages()));
	let storeReady = $state(false);

	// Issue #214: ask before leaving with unsaved edits (or mid-save). `store`
	// is re-created by `loadForm()`, so read it at call time. The attachments
	// panel below saves immediately and has nothing to guard.
	const guard = guardUnsavedChanges({
		isDirty: () => storeReady && store.isDirty,
		isSaving: () => formResource?.saving ?? false
	});

	// Issue #215/#255 review (fix 2): a save's response can arrive after this
	// page is no longer relevant - the user logged out and someone else
	// logged in before the request settled, or simply navigated elsewhere
	// while it was in flight. `guard.canAutoNavigate` only decides whether
	// `goto()` below runs; it does nothing to stop `noteLastEditedRecord`
	// from writing a marker that outlives this page either way. `destroyed`
	// covers "the user moved on" in general; `scope` (above) covers the case
	// where the session this page was built for has ended - even if the same
	// account has signed in again since (a new session generation).
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
	});

	// Shared by the initial mount effect and the "reload" action below (Fix:
	// a transient/storage error used to be rendered as the generic
	// resource-not-found copy, indistinguishable from a genuinely missing
	// id; a `not_found` ProviderError is the only case that should show that
	// message - anything else gets its own message plus a way to retry
	// without a full page navigation).
	async function loadForm() {
		if (!formResource) return;
		await formResource.load();
		if (formResource.initialValues) {
			store = createFormStore(schema, formResource.initialValues, formValidationMessages());
			storeReady = true;
		}
	}

	$effect(() => {
		void loadForm();
	});

	const isNotFoundError = $derived.by(() => {
		if (!idValid) return true;
		const err = formResource?.error;
		return isProviderError(err) && err.body.kind === 'not_found';
	});

	async function handleSubmit(values: Record<string, unknown>) {
		// Defense in depth (spec M10 RBAC): the submit button is disabled for
		// `!canWrite` via BantoForm's `submitting` prop above, but the backend
		// is the real enforcement point either way (a `viewer` calling
		// items_update/PUT gets `BantoError::Forbidden`) - this guard just
		// avoids a pointless round trip.
		if (!formResource || !canWrite) return;
		const result = await formResource.submit(values);
		if (result.ok) {
			// Issue #215/#255 review: only write the marker if this page
			// hasn't been torn down since AND its session is still the live
			// one (`noteLastEditedRecord` refuses a stale `scope` itself).
			// Otherwise user A's save held in flight across a logout and the
			// next login (B, or A again) would leave A's row as the marker
			// of the new session. `result.row` is the server-confirmed row;
			// `parsedId` is included too since some DataProviders'
			// create/update responses don't echo `id` back.
			if (!destroyed) {
				noteLastEditedRecord(scope, resource.name, {
					id: parsedId,
					values: { id: parsedId, ...(result.row as Record<string, unknown>) }
				});
			}
			// Saved: nothing is unsaved any more, so the move back to the list
			// must not prompt; and don't override a screen the user already
			// chose while the save was in flight (even if it is still loading).
			store.markClean();
			if (guard.canAutoNavigate) goto(resolve(`items`));
		} else {
			store.setServerErrors(result.fieldErrors);
		}
	}

	async function handleDelete() {
		if (!formResource || !canWrite) return;
		if (!window.confirm(m['items.deleteConfirm']())) return;
		const removed = await formResource.remove();
		if (!removed) return;
		// The record is gone: unsaved edits to it are moot, don't prompt.
		store.markClean();
		if (guard.canAutoNavigate) goto(resolve(`items`));
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['items.editTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if isNotFoundError}
			<EmptyState
				title={m['items.notFoundTitle']({ resource: resource.label })}
				description={m['items.notFoundDesc']()}
			>
				{#snippet action()}
					<a class="banto-btn banto-btn--secondary" href={resolve(`items`)}
						>{m['common.backToList']()}</a
					>
				{/snippet}
			</EmptyState>
		{:else if formResource?.loading}
			<LoadingState label={m['common.loading']()} />
		{:else if formResource?.error}
			<ErrorState title={m['items.loadError']()} description={m['items.loadErrorDesc']()}>
				{#snippet action()}
					<div class="error-actions">
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							onclick={() => void loadForm()}
						>
							{m['common.reload']()}
						</button>
						<a class="banto-btn banto-btn--ghost" href={resolve(`items`)}
							>{m['common.backToList']()}</a
						>
					</div>
				{/snippet}
			</ErrorState>
		{:else if storeReady}
			<BantoForm
				appearance="underline"
				{schema}
				{store}
				onSubmit={handleSubmit}
				submitting={(formResource?.saving ?? false) || !canWrite}
				submitLabel={m['common.save']()}
			>
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
				{#if canWrite}
					<button type="button" class="banto-btn banto-btn--danger" onclick={handleDelete}>
						{m['common.delete']()}
					</button>
				{/if}
				<!-- Cancel = back to the list; the guard asks first if anything is unsaved. -->
				<a class="banto-btn banto-btn--ghost" href={resolve(`items`)}>{m['common.backToList']()}</a>
			</BantoForm>
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		/* Readable form width (design.md §Phase 4), not the full page width. */
		max-width: 720px;
	}

	.form-panel {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		/* Keep native date segments usable in a narrow form at enlarged text. */
		padding: min(var(--banto-space-5), 3%);
	}

	.error-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
</style>
