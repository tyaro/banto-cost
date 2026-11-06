<script lang="ts">
	/**
	 * データ管理カテゴリ（choiapp-feedback-2026-09 §3）: 監査ログ保持 /
	 * バックアップ・リストア（危険操作カード）。`+page.svelte` の
	 * `<section id="data">` ラッパー（admin かつ実バックエンド）から描画される
	 * （settings-split refactor: markup/state/CSS の移動のみ、挙動は変えない）。
	 *
	 * `backupPostgresDialect` は `systemInfoStore`（systemInfoStore.svelte.ts、
	 * ConnectivitySection.svelte が所有するロード effect）を読む -
	 * `isBackupsAvailable()`/`isSystemInfoAvailable()` は同一条件なので、この
	 * セクションの backups カードが出る時は常に ConnectivitySection の
	 * System Info カードも存在し、ロードが既に走っている。
	 */
	import { DatabaseBackup, ScrollText } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { SurfaceCard } from '@banto/ui';
	import {
		getAuditConfig,
		isAuditLogAvailable,
		setAuditConfig,
		type AuditSettings
	} from '#lib/banto/auditLogAdmin.js';
	import {
		cancelPendingRestore,
		createBackup,
		downloadBackup,
		getPendingRestore,
		isBackupsAvailable,
		listBackups,
		openBackupsFolder,
		stageRestoreFromBackup,
		uploadAndStageRestore,
		type BackupInfo,
		type PendingRestoreInfo
	} from '#lib/banto/backupsAdmin.js';
	import { toastStore } from '#lib/toast.svelte.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { isAdmin } from '#lib/permissions.js';
	import { errorMessage, formatBytes, tauri } from './shared';
	import { systemInfoStore } from './systemInfoStore.svelte';

	// --- M14: audit-log retention policy (Tauri + LAN browser) --------------
	// Unlike server/auth-mode settings, this section is not Tauri-only:
	// `auditLogAdmin.ts` has a REST fallback (`GET`/`PUT /api/audit-log/config`,
	// spec M14 Phase B) so a LAN browser admin can also see/change the
	// retention policy, not just the desktop app - so this section is gated
	// on `auditAvailable` (real backend, not the plain-browser demo) rather
	// than `tauri`.
	const auditAvailable = isAuditLogAvailable();

	let auditConfig = $state<AuditSettings | null>(null);
	// 0 is the wire sentinel for "unlimited" on both fields (spec M14,
	// `SettingsService::set_audit_config`/`normalize_retention`) - shown to
	// the admin as a plain 0 with an explanatory note below, rather than a
	// separate checkbox, mirroring the Rust-side convention exactly.
	let retentionDaysDraft = $state(90);
	let retentionRowsDraft = $state(100_000);
	let applyingAudit = $state(false);
	let auditError: string | null = $state(null);

	function applyAuditConfigToDrafts(config: AuditSettings): void {
		auditConfig = config;
		retentionDaysDraft = config.retentionDays ?? 0;
		retentionRowsDraft = config.retentionRows ?? 0;
	}

	$effect(() => {
		if (!auditAvailable || !isAdmin(sessionStore.role)) return;
		void (async () => {
			try {
				applyAuditConfigToDrafts(await getAuditConfig());
			} catch (err) {
				auditError = errorMessage(err);
			}
		})();
	});

	async function saveAuditConfig(): Promise<void> {
		applyingAudit = true;
		auditError = null;
		try {
			applyAuditConfigToDrafts(
				await setAuditConfig({
					retentionDays: retentionDaysDraft > 0 ? retentionDaysDraft : null,
					retentionRows: retentionRowsDraft > 0 ? retentionRowsDraft : null
				})
			);
			toastStore.push('success', m['settings.auditUpdated']());
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			applyingAudit = false;
		}
	}

	// --- M17: SQLite backup/restore (Tauri + LAN browser, admin only) -------
	// Same availability gate as the audit-log section above (real backend,
	// not the plain-browser demo) - `backupsAdmin.ts`'s REST fallback means a
	// LAN browser admin gets this section too, not just the desktop app.
	const backupsAvailable = isBackupsAvailable();

	let backups = $state<BackupInfo[]>([]);
	let pendingRestore = $state<PendingRestoreInfo | null>(null);
	let loadingBackups = $state(false);
	let creatingBackup = $state(false);
	let stagingRestore = $state(false);
	let cancellingRestore = $state(false);
	let backupsError: string | null = $state(null);
	let restoreFileInput: HTMLInputElement | undefined = $state();

	// Built-in backup/restore is SQLite-only (V2 added PostgreSQL support to the
	// rest of the app, but not to the backup service, which errors explicitly on
	// PG). Swap the operation UI for a notice once the dialect is known via
	// System Info (ConnectivitySection.svelte, systemInfoStore.svelte.ts) above;
	// while it's unknown (demo mode, not yet loaded, or the System Info fetch
	// failed) keep showing the SQLite UI unchanged.
	const backupPostgresDialect = $derived(systemInfoStore.value?.dbDialect === 'postgres');

	async function reloadBackups(): Promise<void> {
		backups = await listBackups();
	}

	async function reloadPendingRestore(): Promise<void> {
		pendingRestore = await getPendingRestore();
	}

	$effect(() => {
		if (!backupsAvailable || !isAdmin(sessionStore.role)) return;
		void (async () => {
			loadingBackups = true;
			backupsError = null;
			try {
				await Promise.all([reloadBackups(), reloadPendingRestore()]);
			} catch (err) {
				backupsError = errorMessage(err);
			} finally {
				loadingBackups = false;
			}
		})();
	});

	async function handleCreateBackup(): Promise<void> {
		creatingBackup = true;
		backupsError = null;
		try {
			await createBackup();
			toastStore.push('success', m['backup.created']());
			await reloadBackups();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			creatingBackup = false;
		}
	}

	async function handleDownloadBackup(fileName: string): Promise<void> {
		try {
			await downloadBackup(fileName);
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		}
	}

	async function handleOpenBackupsFolder(): Promise<void> {
		try {
			const result = await openBackupsFolder();
			if (!result.opened) {
				toastStore.push('info', m['backup.openFolderUnsupported']({ path: result.path }));
			}
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		}
	}

	// Confirmation copy is fixed per spec M17 ("現在のデータは適用時に自動
	// バックアップされます。適用には再起動が必要です" must be explicit) -
	// only the leading line describing the source (existing file vs upload)
	// varies between the two callers below.
	function confirmRestore(sourceDescription: string): boolean {
		return window.confirm(m['backup.restoreConfirm']({ source: sourceDescription }));
	}

	async function handleRestoreFromExisting(fileName: string): Promise<void> {
		if (!confirmRestore(m['backup.restoreSourceExisting']({ fileName }))) return;
		stagingRestore = true;
		try {
			await stageRestoreFromBackup(fileName);
			toastStore.push('success', m['backup.restoreStaged']());
			await reloadPendingRestore();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			stagingRestore = false;
		}
	}

	function handleRestoreFileButtonClick(): void {
		restoreFileInput?.click();
	}

	async function handleRestoreFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file (e.g. after fixing it) later
		if (!file) return;
		if (!confirmRestore(m['backup.restoreSourceUpload']({ fileName: file.name }))) return;

		stagingRestore = true;
		try {
			await uploadAndStageRestore(file);
			toastStore.push('success', m['backup.restoreStaged']());
			await reloadPendingRestore();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			stagingRestore = false;
		}
	}

	async function handleCancelRestore(): Promise<void> {
		cancellingRestore = true;
		try {
			await cancelPendingRestore();
			toastStore.push('success', m['backup.restoreCancelled']());
			pendingRestore = null;
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			cancellingRestore = false;
		}
	}
</script>

<div class="settings-grid">
	{#if auditAvailable}
		<SurfaceCard>
			<div class="card-head">
				<ScrollText size={20} aria-hidden="true" />
				<div>
					<h3>{m['settings.auditHeading']()}</h3>
					<p>{m['settings.auditDesc']()}</p>
				</div>
			</div>

			<div class="server-fields">
				<label class="banto-field banto-field--stacked">
					<input
						class="banto-field-control"
						type="number"
						placeholder=" "
						min="0"
						bind:value={retentionDaysDraft}
					/>
					<span class="banto-field-label">{m['settings.retentionDays']()}</span>
				</label>
				<label class="banto-field">
					<input
						class="banto-field-control"
						type="number"
						placeholder=" "
						min="0"
						bind:value={retentionRowsDraft}
					/>
					<span class="banto-field-label">{m['settings.retentionRows']()}</span>
				</label>
			</div>

			<button
				type="button"
				class="banto-btn banto-btn--primary"
				onclick={saveAuditConfig}
				disabled={applyingAudit}
			>
				{m['common.save']()}
			</button>

			{#if auditError}
				<p class="error">{auditError}</p>
			{/if}

			{#if auditConfig}
				<p class="status">
					{m['settings.currentConfig']()}
					<strong>
						{auditConfig.retentionDays !== null
							? m['audit.retentionDaysValue']({ days: auditConfig.retentionDays })
							: m['audit.retentionUnlimited']()}
						/ {auditConfig.retentionRows !== null
							? m['audit.retentionRowsValue']({
									rows: auditConfig.retentionRows.toLocaleString()
								})
							: m['audit.retentionRowsUnlimited']()}
					</strong>
				</p>
			{/if}

			<p class="note">
				{m['settings.auditNote']()}
			</p>
		</SurfaceCard>
	{/if}

	{#if backupsAvailable}
		<div class="danger-card">
			<SurfaceCard>
				<div class="card-head card-head--danger">
					<DatabaseBackup size={20} aria-hidden="true" />
					<div>
						<h3>{m['backup.heading']()}</h3>
						<p>{m['backup.desc']()}</p>
					</div>
				</div>

				{#if backupPostgresDialect}
					<p class="note">{m['backup.postgresNotice']()}</p>
				{:else}
					<div class="backup-toolbar">
						<button
							type="button"
							class="banto-btn banto-btn--primary"
							onclick={handleCreateBackup}
							disabled={creatingBackup}
						>
							{creatingBackup ? m['backup.creating']() : m['backup.createNow']()}
						</button>
						{#if tauri}
							<button
								type="button"
								class="banto-btn banto-btn--secondary"
								onclick={handleOpenBackupsFolder}
							>
								{m['backup.openFolder']()}
							</button>
						{/if}
					</div>

					{#if backupsError}
						<p class="error">{backupsError}</p>
					{/if}

					{#if pendingRestore}
						<p class="pending-restore">
							{m['backup.pendingApplied']()}<strong>{pendingRestore.stagedAt}</strong
							>（{formatBytes(pendingRestore.sizeBytes)}）
							<button
								type="button"
								class="banto-btn banto-btn--secondary"
								onclick={handleCancelRestore}
								disabled={cancellingRestore}
							>
								{m['backup.cancel']()}
							</button>
						</p>
					{/if}

					{#if loadingBackups}
						<p class="note">{m['common.loading']()}</p>
					{:else if backups.length === 0}
						<p class="note">{m['backup.empty']()}</p>
					{:else}
						<ul class="backup-list">
							{#each backups as backup (backup.fileName)}
								<li>
									<div class="backup-info">
										<span class="file-name">{backup.fileName}</span>
										<span class="meta">{formatBytes(backup.sizeBytes)} ・ {backup.createdAt}</span>
									</div>
									<div class="backup-actions">
										{#if !tauri}
											<button
												type="button"
												class="banto-btn banto-btn--secondary"
												onclick={() => handleDownloadBackup(backup.fileName)}
											>
												{m['backup.download']()}
											</button>
										{/if}
										<button
											type="button"
											class="banto-btn banto-btn--danger"
											onclick={() => handleRestoreFromExisting(backup.fileName)}
											disabled={stagingRestore}
										>
											{m['backup.restoreFromThis']()}
										</button>
									</div>
								</li>
							{/each}
						</ul>
					{/if}

					{#if !tauri}
						<div class="restore-upload">
							<button
								type="button"
								class="banto-btn banto-btn--danger"
								onclick={handleRestoreFileButtonClick}
								disabled={stagingRestore}
							>
								{m['backup.restoreFromFile']()}
							</button>
							<input
								class="file-input"
								type="file"
								accept=".sqlite3"
								aria-label={m['backup.restoreFromFile']()}
								bind:this={restoreFileInput}
								onchange={handleRestoreFileChange}
							/>
						</div>
					{/if}

					<p class="note">
						{m['backup.note']()}
					</p>
				{/if}
			</SurfaceCard>
		</div>
	{/if}
</div>
