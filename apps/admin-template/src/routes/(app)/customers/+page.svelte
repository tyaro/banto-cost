<script lang="ts">
	/**
	 * 顧客マスタ一覧 (banto-cost P3a, docs/recipes/add-resource.md step 8).
	 * Deliberately lean compared with the items list: a read-only BantoGrid
	 * whose columns derive from `customersSchema` (M23) plus a row link and a
	 * "new" button. Reading needs admin or the `ViewMasters` capability; a
	 * `forbidden` answer shows a no-access state instead of an error.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { BantoGrid, columnsFromSchema, type GridColumn } from '@banto/grid-svelte';
	import type { FormSchema } from '@banto/forms';
	import { createListResource, getResource } from '@banto/admin-core';
	import { Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import { isForbiddenError } from '#lib/banto/costFormat.js';
	import type { Customer } from '#lib/banto/resources/customers.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';

	const resource = getResource('customers');
	const schema = resource.schema as FormSchema;
	const canWrite = $derived(canWriteResources(sessionStore.role));

	const list = createListResource<Customer>('customers', {
		initialParams: { pagination: { offset: 0, limit: 5_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const columns: GridColumn<Customer>[] = [
		{
			id: 'open',
			header: m['cost.colActions'](),
			accessor: () => '',
			width: 70,
			resizable: false,
			sortable: false,
			cell: (row) => ({ text: m['cost.open'](), href: resolve(`customers/${row.id}`) })
		},
		...columnsFromSchema<Customer>(schema, {
			editable: false,
			overrides: {
				name: { width: 280 },
				active: {
					width: 100,
					format: (value) => (value ? m['customers.activeYes']() : m['customers.activeNo']())
				},
				note: { width: 320 },
				updatedAt: { width: 170 }
			}
		})
	];

	const forbidden = $derived(isForbiddenError(list.error));
</script>

<div class="page">
	<PageHeader hideTitle title={resource.label} description={m['customers.description']()}>
		{#snippet actions()}
			{#if canWrite}
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={() => goto(resolve(`customers/new`))}
				>
					<Plus size={16} aria-hidden="true" />
					{m['customers.create']()}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if forbidden}
		<EmptyState title={m['cost.forbiddenTitle']()} description={m['cost.forbiddenDesc']()} />
	{:else if list.error}
		<ErrorState title={m['cost.loadError']()} description={list.error.message}>
			{#snippet action()}
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					onclick={() => void list.load()}
				>
					{m['common.reload']()}
				</button>
			{/snippet}
		</ErrorState>
	{:else if list.loading && list.rows.length === 0}
		<LoadingState label={m['common.loading']()} />
	{:else if list.rows.length === 0}
		<EmptyState title={m['customers.emptyTitle']()} description={m['customers.emptyDesc']()} />
	{:else}
		<div class="grid-wrap">
			<BantoGrid rows={list.rows} {columns} messages={gridMessages()} getRowId={(row) => row.id} />
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* BantoGrid virtualizes, so it needs a definite height (component shape). */
	.grid-wrap {
		height: 70vh;
		min-height: 320px;
	}
</style>
