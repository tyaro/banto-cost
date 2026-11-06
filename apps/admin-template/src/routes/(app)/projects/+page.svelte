<script lang="ts">
	/**
	 * 案件台帳一覧 (banto-cost P3a, spec §5.1; docs/recipes/add-resource.md
	 * step 8). The server already narrows the list to the caller's project
	 * scope (admin: all, others: the projects they may view - design 第2章),
	 * so this page only renders what comes back. Columns derive from
	 * `projectsSchema` (M23); the customer / manager names and the update time
	 * are joined columns outside the form schema, written by hand.
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
	import type { Project } from '#lib/banto/resources/projects.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { PageHeader, EmptyState, ErrorState, LoadingState } from '@banto/ui';

	const resource = getResource('projects');
	const schema = resource.schema as FormSchema;
	const canWrite = $derived(canWriteResources(sessionStore.role));

	const list = createListResource<Project>('projects', {
		initialParams: { pagination: { offset: 0, limit: 5_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	// The ids are shown through the joined name columns below; the note is
	// long free text that belongs on the detail page.
	const OMITTED = new Set(['customerId', 'managerUserId', 'note']);
	const schemaColumns = columnsFromSchema<Project>(schema, {
		editable: false,
		overrides: {
			code: { width: 130 },
			name: { width: 260 },
			status: { width: 110 },
			plannedStart: { width: 130 },
			plannedEnd: { width: 130 },
			orderNo: { width: 130, hidden: true },
			department: { width: 140, hidden: true }
		}
	}).filter((column) => !OMITTED.has(column.id));

	const byId = (id: string) => schemaColumns.filter((column) => column.id === id);

	const columns: GridColumn<Project>[] = [
		{
			id: 'open',
			header: m['cost.colActions'](),
			accessor: () => '',
			width: 70,
			resizable: false,
			sortable: false,
			cell: (row) => ({ text: m['cost.open'](), href: resolve(`projects/${row.id}`) })
		},
		...byId('code'),
		...byId('name'),
		{
			id: 'customerName',
			header: m['projects.fieldCustomer'](),
			accessor: 'customerName',
			width: 200,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'managerName',
			header: m['projects.fieldManager'](),
			accessor: 'managerName',
			width: 140,
			filterable: true,
			filterType: 'text'
		},
		...schemaColumns.filter((column) => !['code', 'name'].includes(column.id)),
		{
			id: 'updatedAt',
			header: m['projects.fieldUpdatedAt'](),
			accessor: 'updatedAt',
			width: 170
		}
	];

	const forbidden = $derived(isForbiddenError(list.error));
</script>

<div class="page">
	<PageHeader hideTitle title={resource.label} description={m['projects.description']()}>
		{#snippet actions()}
			{#if canWrite}
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={() => goto(resolve(`projects/new`))}
				>
					<Plus size={16} aria-hidden="true" />
					{m['projects.create']()}
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
		<EmptyState title={m['projects.emptyTitle']()} description={m['projects.emptyDesc']()} />
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
