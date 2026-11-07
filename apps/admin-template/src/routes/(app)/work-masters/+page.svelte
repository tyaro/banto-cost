<script lang="ts">
	/**
	 * 管理設定 → 工程・共通活動 (spec §5.2 / §9, banto-cost P4b): the phases a
	 * project's hours are entered against and the common activities (社内会議・
	 * 教育・営業・待機) that belong to no project. Reading needs any capability
	 * (or the `admin` role); maintaining them needs the `admin` role or a
	 * business capability that maintains masters (sales, project management,
	 * accounting) - the server decides (MasterTable.svelte). Demo mode has no
	 * backend.
	 */
	import { PageHeader, EmptyState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { canWriteResources } from '#lib/permissions.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import MasterTable from './MasterTable.svelte';

	const available = isPipelineAvailable();
	const canWrite = $derived(canWriteResources(sessionStore.role));
	let phasesPending = $state({ dirty: false, busy: false });
	let activitiesPending = $state({ dirty: false, busy: false });
	const guard = guardUnsavedChanges({
		isDirty: () => phasesPending.dirty || activitiesPending.dirty,
		isSaving: () => phasesPending.busy || activitiesPending.busy
	});
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['nav.workMasters']()}
		description={m['workMasters.description']()}
	/>
	{#if !available}
		<EmptyState title={m['time.demoUnavailable']()} />
	{:else}
		<div class="grid">
			<MasterTable
				kind="phases"
				title={m['workMasters.phases']()}
				{canWrite}
				onPendingChange={(p) => (phasesPending = p)}
			/>
			<MasterTable
				kind="activities"
				title={m['workMasters.activities']()}
				{canWrite}
				onPendingChange={(p) => (activitiesPending = p)}
			/>
		</div>
	{/if}
	<p class="sr-only" aria-live="polite">{guard.pending ? m['unsaved.notice']() : ''}</p>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		max-width: 1200px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
		gap: var(--banto-space-4);
		align-items: start;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
