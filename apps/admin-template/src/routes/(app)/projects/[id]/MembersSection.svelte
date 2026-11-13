<script lang="ts">
	/**
	 * 案件詳細 → 担当者 (review F-2, §8-15, ADR-0028): who takes part in the
	 * project. The members are what project scope reads - a worker (作業者)
	 * may enter hours and costs on it, a sales owner (担当営業) may update its
	 * pipeline, each with the matching capability.
	 *
	 * Reading needs the `admin` role or `ViewProject` on the project (the
	 * page itself needs the same). Adding and removing a sales owner or a
	 * worker is system administration (`admin` role), so only an admin gets
	 * the form; the server decides either way. The manager (責任者) row
	 * follows the project's 責任者 field (the server keeps it in the same
	 * transaction), so it is listed here but changed in the basic information.
	 */
	import { isProviderError } from '@banto/admin-core';
	import { LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { isForbiddenError } from '#lib/banto/costFormat.js';
	import { listUserNames, userNameOptions, type UserName } from '#lib/banto/userNames.js';
	import {
		EDITABLE_MEMBER_KINDS,
		addProjectMember,
		listProjectMembers,
		removeProjectMember,
		sortMembers,
		type MemberKind,
		type ProjectMember
	} from '#lib/banto/projectMembersAdmin.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { isAdmin } from '#lib/permissions.js';
	import { toastStore } from '#lib/toast.svelte.js';

	interface Props {
		projectId: number;
		/** Bumped by the page after the basic information is saved (the manager may have changed). */
		reloadKey?: number;
	}

	let { projectId, reloadKey = 0 }: Props = $props();

	const available = isPipelineAvailable();
	const canEdit = $derived(isAdmin(sessionStore.role));
	/**
	 * The rows with the project they were read for: only the current
	 * project's rows are shown and acted on, so moving to another project
	 * never offers the previous one's members (PR #60 review).
	 */
	let read = $state<{ projectId: number; rows: ProjectMember[] } | null>(null);
	const members = $derived(read && read.projectId === projectId ? read.rows : null);
	let names = $state<UserName[]>([]);
	let loadError = $state<unknown>(null);
	let busy = $state(false);
	let newUser = $state('');
	let newKind = $state<MemberKind>('worker');
	let loadToken = 0;
	let namesToken = 0;

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const got = await listProjectMembers(id);
			if (token !== loadToken) return;
			read = { projectId: id, rows: got };
		} catch (err) {
			if (token !== loadToken) return;
			loadError = err;
			read = null;
		}
	}

	/**
	 * Names are a convenience, read apart from the members (PR #60 review): a
	 * slow or failed read never holds back the list and the form - the rows
	 * show the id and the form takes one until the names arrive.
	 */
	async function loadNames() {
		if (!available) return;
		const token = ++namesToken;
		try {
			const got = await listUserNames();
			if (token === namesToken) names = got;
		} catch {
			// Keep what is shown (the ids, or names read earlier).
		}
	}

	$effect(() => {
		void reloadKey;
		void load(projectId);
		void loadNames();
	});

	const nameOptions = $derived(userNameOptions(names));
	const nameOf = $derived(new Map(nameOptions.map((o) => [o.value, o.label])));
	const sorted = $derived(
		members ? sortMembers(members, new Map(names.map((n, i) => [n.id, i]))) : []
	);

	function kindLabel(kind: MemberKind): string {
		if (kind === 'manager') return m['members.kindManager']();
		if (kind === 'sales') return m['members.kindSales']();
		return m['members.kindWorker']();
	}

	function userLabel(userId: number): string {
		return nameOf.get(userId) ?? `#${userId}`;
	}

	function errorText(err: unknown): string {
		return isProviderError(err) ? err.message : String(err);
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		const userId = Number(newUser);
		if (busy || !newUser || !Number.isInteger(userId) || !members) return;
		const id = projectId;
		const startedAt = loadToken;
		busy = true;
		try {
			const rows = await addProjectMember(id, userId, newKind);
			// Only while still on the same project and no read started since
			// (that read answers with the added member as well).
			if (id === projectId && loadToken === startedAt) {
				++loadToken;
				read = { projectId: id, rows };
			}
			newUser = '';
			toastStore.push('success', m['members.added']());
		} catch (err) {
			toastStore.push('error', errorText(err));
		} finally {
			busy = false;
		}
	}

	async function remove(member: ProjectMember) {
		// The row names its own project: never send it with another one's id.
		if (busy || member.projectId !== projectId) return;
		busy = true;
		try {
			await removeProjectMember(member.projectId, member.userId, member.kind);
			toastStore.push('success', m['members.removed']());
			// Moved to another project meanwhile: its own read stands.
			if (member.projectId === projectId) await load(projectId);
		} catch (err) {
			toastStore.push('error', errorText(err));
		} finally {
			busy = false;
		}
	}
</script>

<section class="members" aria-labelledby="members-heading">
	<h2 id="members-heading">{m['members.sectionTitle']()}</h2>
	{#if !available}
		<p class="note">{m['members.demoUnavailable']()}</p>
	{:else if isForbiddenError(loadError)}
		<p class="note">{m['members.forbidden']()}</p>
	{:else if loadError}
		<p class="error" role="alert">{errorText(loadError)}</p>
		<div>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => void load(projectId)}
			>
				{m['common.reload']()}
			</button>
		</div>
	{:else if !members}
		<LoadingState label={m['common.loading']()} />
	{:else}
		<p class="note">{m['members.hint']()}</p>
		{#if sorted.length === 0}
			<p class="note">{m['members.none']()}</p>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="sr-only">{m['members.sectionTitle']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['members.fieldKind']()}</th>
							<th scope="col">{m['members.fieldUser']()}</th>
							{#if canEdit}<th scope="col"><span class="sr-only">{m['members.actions']()}</span></th
								>{/if}
						</tr>
					</thead>
					<tbody>
						{#each sorted as member (`${member.kind}:${member.userId}`)}
							<tr>
								<td>{kindLabel(member.kind)}</td>
								<td>{userLabel(member.userId)}</td>
								{#if canEdit}
									<td class="row-actions">
										{#if member.kind === 'manager'}
											<span class="note">{m['members.managerHint']()}</span>
										{:else}
											<button
												type="button"
												class="banto-btn banto-btn--ghost"
												disabled={busy}
												aria-label={m['members.removeLabel']({
													kind: kindLabel(member.kind),
													name: userLabel(member.userId)
												})}
												onclick={() => void remove(member)}
											>
												{m['members.remove']()}
											</button>
										{/if}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if canEdit}
			<form class="add" onsubmit={add}>
				<label class="field">
					<span>{m['members.fieldUser']()}</span>
					{#if nameOptions.length > 0}
						<select class="banto-input" bind:value={newUser} required>
							<option value="">{m['members.chooseUser']()}</option>
							{#each nameOptions as option (option.value)}
								<option value={String(option.value)}>{option.label}</option>
							{/each}
						</select>
					{:else}
						<input class="banto-input" inputmode="numeric" bind:value={newUser} required />
					{/if}
				</label>
				<label class="field">
					<span>{m['members.fieldKind']()}</span>
					<select class="banto-input" bind:value={newKind}>
						{#each EDITABLE_MEMBER_KINDS as kind (kind)}
							<option value={kind}>{kindLabel(kind)}</option>
						{/each}
					</select>
				</label>
				<div class="actions">
					<button type="submit" class="banto-btn banto-btn--primary" disabled={busy || !newUser}>
						{m['members.add']()}
					</button>
				</div>
			</form>
		{:else}
			<p class="note">{m['members.adminOnly']()}</p>
		{/if}
	{/if}
</section>

<style>
	.members {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
	}

	th,
	td {
		padding: var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		text-align: left;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.row-actions {
		text-align: right;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field input,
	.field select {
		color: var(--banto-text);
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
