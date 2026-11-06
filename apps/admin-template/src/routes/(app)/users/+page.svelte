<script lang="ts">
	/**
	 * ユーザー管理画面（spec M10 RBAC）。`admin` のみ到達（+page.ts が非adminを
	 * ダッシュボードへリダイレクト）。デモモード（プレーンな vite dev/preview、
	 * バックエンドなし）ではアカウントDBそのものが存在しないため、案内文のみ表示
	 * する（isUsersAdminAvailable()）。
	 *
	 * 一覧はBantoGrid（クライアントモード、全件を一度に取得）。BantoGridの
	 * セル編集は「1カラム=1値」のインライン編集向けで、行ごとの複数ボタン（削除
	 * ＋パスワードリセット）を埋め込む手段がないため、行クリックで選択→下に
	 * 詳細/編集/リセット/削除パネルを表示する構成にしている（items.[id]ページの
	 * 「クリックで編集ページへ」と同じ発想を、別ページ遷移ではなくページ内表示
	 * にしたもの）。
	 */
	import { untrack, type Component } from 'svelte';
	import { BantoGrid, type GridColumn } from '@banto/grid-svelte';
	import { BantoForm, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { isProviderError } from '@banto/admin-core';
	import {
		Eye,
		KeyRound,
		Pencil,
		ShieldAlert,
		ShieldCheck,
		Trash2,
		UserRoundPlus,
		Users
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toastStore } from '#lib/toast.svelte.js';
	import {
		PageHeader,
		SurfaceCard,
		StatusBadge,
		type StatusBadgeVariant,
		EmptyState,
		LoadingState
	} from '@banto/ui';
	import {
		createUser,
		deleteUser,
		isUsersAdminAvailable,
		listUsers,
		resetUserPassword,
		updateUser,
		type Role as UserRole,
		type UserSummary
	} from '#lib/banto/usersAdmin.js';

	const roleOptions: { value: UserRole; label: string }[] = [
		{ value: 'admin', label: m['role.admin']() },
		{ value: 'editor', label: m['role.editor']() },
		{ value: 'viewer', label: m['role.viewer']() }
	];

	function roleLabel(role: UserRole): string {
		return roleOptions.find((option) => option.value === role)?.label ?? role;
	}

	// StatusBadge (visual-refresh-design.md §10): role never relies on color
	// alone - admin gets the "info" variant, editor/viewer both "neutral" but
	// keep distinct icons so they stay visually distinguishable from each
	// other too.
	const roleBadgeVariant: Record<UserRole, StatusBadgeVariant> = {
		admin: 'info',
		editor: 'neutral',
		viewer: 'neutral'
	};
	const roleBadgeIcon: Record<UserRole, Component> = {
		admin: ShieldCheck,
		editor: Pencil,
		viewer: Eye
	};

	function errorMessage(err: unknown): string {
		return isProviderError(err) ? err.message : String(err);
	}

	const available = isUsersAdminAvailable();

	const createSchema: FormSchema = {
		fields: [
			{
				name: 'username',
				label: m['common.username'](),
				type: 'text',
				required: true,
				min: 1,
				max: 32
			},
			{
				name: 'password',
				label: m['common.passwordMinLabel'](),
				type: 'password',
				required: true,
				min: 8
			},
			{
				name: 'displayName',
				label: m['common.displayName'](),
				type: 'text',
				required: true,
				min: 1
			},
			{
				name: 'role',
				label: m['common.role'](),
				type: 'select',
				required: true,
				default: 'viewer',
				options: roleOptions
			}
		]
	};

	let createStore = $state(createFormStore(createSchema));
	let creating = $state(false);

	let users: UserSummary[] = $state([]);
	let loading = $state(false);
	let loadToken = 0;

	async function reload(): Promise<void> {
		if (!available) return;
		const token = ++loadToken;
		loading = true;
		try {
			const loaded = await listUsers();
			if (token === loadToken) users = loaded;
		} catch (err) {
			if (token === loadToken) toastStore.push('error', errorMessage(err));
		} finally {
			if (token === loadToken) loading = false;
		}
	}

	$effect(() => {
		untrack(() => void reload());
	});

	async function handleCreate(values: Record<string, unknown>): Promise<void> {
		creating = true;
		try {
			await createUser({
				username: String(values.username),
				password: String(values.password),
				displayName: String(values.displayName),
				role: values.role as UserRole
			});
			toastStore.push('success', m['users.created']());
			createStore = createFormStore(createSchema);
			await reload();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				createStore.setServerErrors(err.body.field_errors);
			} else {
				toastStore.push('error', errorMessage(err));
			}
		} finally {
			creating = false;
		}
	}

	const columns: GridColumn<UserSummary>[] = [
		{ id: 'id', header: 'ID', accessor: 'id', width: 70, align: 'right' },
		{
			id: 'username',
			header: m['common.username'](),
			accessor: 'username',
			width: 160,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'displayName',
			header: m['common.displayName'](),
			accessor: 'displayName',
			width: 160,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'role',
			header: m['common.role'](),
			accessor: 'role',
			width: 110,
			format: (value) => roleLabel(value as UserRole)
		},
		{ id: 'createdAt', header: m['users.colCreatedAt'](), accessor: 'createdAt', width: 180 }
	];

	let selected: UserSummary | null = $state(null);
	// Issue #206 / roadmap M10: identity alone cannot distinguish A → B → A
	// from the original edit session.
	let selectionEpoch = 0;
	let editDisplayName = $state('');
	let editRole: UserRole = $state('viewer');
	let saving = $state(false);

	function selectUser(user: UserSummary): void {
		selectionEpoch++;
		selected = user;
		editDisplayName = user.displayName;
		editRole = user.role;
		resetPassword = '';
	}

	async function saveEdit(): Promise<void> {
		if (!selected || saving) return;
		const targetId = selected.id;
		const epoch = selectionEpoch;
		const draft = { displayName: editDisplayName, role: editRole };
		saving = true;
		try {
			const updated = await updateUser(targetId, draft);
			toastStore.push('success', m['users.updated']());
			if (epoch === selectionEpoch && selected?.id === targetId) {
				selected = updated;
				// Fields remain editable while saving; retain input made after submission.
				if (editDisplayName === draft.displayName) editDisplayName = updated.displayName;
				if (editRole === draft.role) editRole = updated.role;
			}
			await reload();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	let resetPassword = $state('');
	let resetting = $state(false);

	async function saveReset(): Promise<void> {
		if (!selected || resetting) return;
		if (resetPassword.length < 8) {
			toastStore.push('error', m['auth.passwordTooShort']());
			return;
		}
		const targetId = selected.id;
		const epoch = selectionEpoch;
		const password = resetPassword;
		resetting = true;
		try {
			await resetUserPassword(targetId, password);
			toastStore.push('success', m['users.passwordReset']());
			if (epoch === selectionEpoch && selected?.id === targetId && resetPassword === password) {
				resetPassword = '';
			}
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			resetting = false;
		}
	}

	let deleting = $state(false);

	async function handleDelete(): Promise<void> {
		if (!selected || deleting) return;
		if (!window.confirm(m['users.deleteConfirm']({ username: selected.username }))) return;
		const targetId = selected.id;
		deleting = true;
		try {
			await deleteUser(targetId);
			toastStore.push('success', m['users.deleted']());
			// roadmap M10: even a new selection of this ID no longer exists.
			// Advance the epoch so pending saves cannot reopen the deleted user.
			if (selected?.id === targetId) {
				selectionEpoch++;
				selected = null;
			}
			await reload();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			deleting = false;
		}
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.users']()} description={m['users.pageDescription']()} />

	{#if !available}
		<EmptyState title={m['users.unavailableTitle']()} description={m['users.unavailableDesc']()} />
	{:else}
		<!-- >=1100px: list (create + grid) and edit panel side by side; below
		     that, stacked (plan Phase 5 "作成、一覧、選択ユーザー編集の関係を明確
		     にする" / "広い画面では一覧と編集を2カラム、狭い画面では縦積み"). -->
		<div class="workspace">
			<div class="list-column">
				<SurfaceCard>
					<div class="card-head">
						<UserRoundPlus size={20} aria-hidden="true" />
						<div>
							<h2>{m['users.createHeading']()}</h2>
							<p>{m['users.createDesc']()}</p>
						</div>
					</div>
					<!-- class="create" kept as a literal <section> (not SurfaceCard's
					     own <section>) - e2e smoke scenario 5 scopes its locators to
					     `section.create` to avoid ambiguity with the grid's column
					     filter buttons below. -->
					<section class="create">
						<BantoForm
							appearance="underline"
							schema={createSchema}
							store={createStore}
							onSubmit={handleCreate}
							submitting={creating}
							submitLabel={m['common.create']()}
						/>
					</section>
				</SurfaceCard>

				<SurfaceCard>
					<div class="card-head">
						<Users size={20} aria-hidden="true" />
						<div>
							<h2>{m['users.listHeading']()}</h2>
							<p>{m['users.listDesc']()}</p>
						</div>
					</div>
					{#if loading && users.length === 0}
						<LoadingState label={m['common.loading']()} />
					{:else}
						<div class="grid-wrap">
							<BantoGrid
								rows={users}
								{columns}
								getRowId={(user) => user.id}
								onRowClick={selectUser}
							/>
						</div>
					{/if}
				</SurfaceCard>
			</div>

			<div class="edit-column">
				{#if selected}
					<SurfaceCard>
						<div class="card-head">
							<Pencil size={20} aria-hidden="true" />
							<div>
								<h2>{m['users.editHeading']({ username: selected.username })}</h2>
								<p>{m['users.editDesc']()}</p>
							</div>
						</div>

						<div class="role-row">
							<StatusBadge
								variant={roleBadgeVariant[selected.role]}
								label={roleLabel(selected.role)}
								icon={roleBadgeIcon[selected.role]}
							/>
						</div>

						<label class="banto-field banto-field--stacked edit-field">
							<input class="banto-field-control" type="text" bind:value={editDisplayName} />
							<span class="banto-field-label">{m['common.displayName']()}</span>
						</label>
						<label class="banto-field banto-field--stacked edit-field">
							<select class="banto-field-control" bind:value={editRole}>
								{#each roleOptions as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
							<span class="banto-field-label">{m['common.role']()}</span>
						</label>
						<button
							type="button"
							class="banto-btn banto-btn--primary"
							onclick={saveEdit}
							disabled={saving}
						>
							{m['common.save']()}
						</button>

						<!-- Danger zone (plan Phase 5): delete + password reset are
						     visually separated from the normal save action above.
						     Confirmation is still required before deletion. -->
						<div class="danger-zone">
							<h3><ShieldAlert size={16} aria-hidden="true" />Danger zone</h3>

							<div class="danger-section">
								<p class="note">{m['users.resetDesc']()}</p>
								<label class="banto-field banto-field--stacked edit-field">
									<input
										class="banto-field-control"
										type="password"
										bind:value={resetPassword}
										autocomplete="new-password"
									/>
									<span class="banto-field-label">{m['common.newPasswordMinLabel']()}</span>
								</label>
								<button
									type="button"
									class="banto-btn banto-btn--danger"
									onclick={saveReset}
									disabled={resetting}
								>
									<KeyRound size={16} aria-hidden="true" />
									{m['users.resetPassword']()}
								</button>
							</div>

							<div class="danger-section">
								<p class="note">{m['users.deleteDesc']()}</p>
								<button
									type="button"
									class="banto-btn banto-btn--danger"
									onclick={handleDelete}
									disabled={deleting}
								>
									<Trash2 size={16} aria-hidden="true" />
									{m['common.delete']()}
								</button>
							</div>
						</div>
					</SurfaceCard>
				{:else}
					<EmptyState
						icon={Users}
						title={m['users.selectPrompt']()}
						description={m['users.selectHint']()}
					/>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(320px, 1fr) minmax(360px, 1fr);
		align-items: start;
		gap: 1rem;
	}

	@media (max-width: 1099.98px) {
		.workspace {
			grid-template-columns: 1fr;
		}
	}

	.list-column,
	.edit-column {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		margin-bottom: 0.75rem;
		color: var(--banto-text-muted);
	}

	.card-head h2 {
		margin: 0;
		font-size: 1rem;
		color: var(--banto-text);
	}

	.card-head p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.role-row {
		margin-bottom: 0.75rem;
	}

	.note {
		margin: 0 0 0.5rem;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.grid-wrap {
		height: 320px;
	}

	.edit-field {
		margin-bottom: 0.75rem;
	}

	.danger-zone {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--banto-danger);
	}

	.danger-zone h3 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		color: var(--banto-danger);
	}

	.danger-section + .danger-section {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px dashed var(--banto-border);
	}

	.danger-section .banto-btn {
		margin-top: 0.25rem;
	}
</style>
