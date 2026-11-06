<script lang="ts">
	/**
	 * セキュリティカテゴリ（choiapp-feedback-2026-09 §3）: 認証を無効化（M11の
	 * escape hatch 含む）。`+page.svelte` の `<section id="security">`
	 * ラッパー（Tauri かつ管理可）から描画される（settings-split refactor:
	 * markup/state/CSS の移動のみ、挙動は変えない）。
	 *
	 * このセクションは `authSettingsStore`（authSettingsStore.svelte.ts、
	 * AccountSection.svelte / ConnectivitySection.svelte とも共有）を実際に
	 * モードを変更する唯一のコントロールとして持つ。初期ロード effect は
	 * settings-routes step 2（Copilot review on PR #198）で
	 * `settings/+layout.svelte` へ移した（`/settings/account` 等への直接
	 * 遷移でもこの値が要るため）- エラー表示は下の `authSettingsStore.error`
	 * を直接読む。`disabledDraft`/`disabledRoleDraft` は `authSettingsStore.value`
	 * が変わるたび（このセクション自身の保存でも、AccountSection の自動ログイン
	 * 操作による再取得でも）下の `$effect` で再同期する - 元の単一
	 * `applyAuthSettingsToDrafts()` が両方を同時に更新していたのと同じ結合を
	 * 保つため。
	 */
	import { refreshAll } from '$app/navigation';
	import { ShieldAlert } from '@lucide/svelte';
	import { UnsavedChangesNotice } from '@banto/forms';
	import * as m from '#lib/paraglide/messages.js';
	import { SurfaceCard } from '@banto/ui';
	import { applyAuthSettings, type AuthDisabledRole } from '#lib/banto/authAdmin.js';
	import { toastStore } from '#lib/toast.svelte.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { errorMessage } from './shared';
	import { authSettingsStore, reloadAuthSettings } from './authSettingsStore.svelte';

	const authDisabledRoleOptions: { value: AuthDisabledRole; label: string }[] = [
		{ value: 'admin', label: m['role.admin']() },
		{ value: 'editor', label: m['role.editor']() },
		{ value: 'viewer', label: m['role.viewer']() }
	];

	let disabledDraft = $state(false);
	let disabledRoleDraft = $state<AuthDisabledRole>('admin');
	let applyingAuth = $state(false);

	// Keep the disable-mode drafts in sync with the shared AuthSettings value
	// whenever it changes (see module doc comment above).
	$effect(() => {
		const value = authSettingsStore.value;
		if (value) {
			disabledDraft = value.disabled;
			disabledRoleDraft = value.disabledRole;
		}
	});

	// Issue #214: drafts differ from the saved AuthSettings. While the value
	// is not loaded (`null`) there is nothing to compare, so never unsaved.
	// A successful save re-syncs the drafts to the new value (see
	// `saveAuthSettings`), so this turns false; a failed save leaves both as
	// they were, so the unsaved marker stays.
	const dirty = $derived.by(() => {
		const value = authSettingsStore.value;
		return (
			value !== null &&
			(disabledDraft !== value.disabled || disabledRoleDraft !== value.disabledRole)
		);
	});
	const guard = guardUnsavedChanges({ isDirty: () => dirty, isSaving: () => applyingAuth });
	// Owner review on PR #232: without the saved AuthSettings the drafts are
	// placeholders with nothing to compare against - an edit could never be
	// detected as unsaved - so they stay disabled until it loads (retry below).
	const editable = $derived(authSettingsStore.value !== null);
	let reloading = $state(false);

	async function retryLoad(): Promise<void> {
		reloading = true;
		try {
			await reloadAuthSettings();
		} finally {
			reloading = false;
		}
	}

	/** Put the drafts back to the saved AuthSettings (the "discard" button, and after a save). */
	function resetDraftsToSaved(): void {
		const value = authSettingsStore.value;
		if (!value) return;
		disabledDraft = value.disabled;
		disabledRoleDraft = value.disabledRole;
	}

	async function saveAuthSettings(): Promise<void> {
		if (disabledDraft && !window.confirm(m['settings.authDisableConfirm']())) {
			return;
		}

		applyingAuth = true;
		try {
			authSettingsStore.value = await applyAuthSettings(disabledDraft, disabledRoleDraft);
			toastStore.push('success', m['settings.authSettingsUpdated']());
			// Issue #214: the save is done - clear the unsaved state NOW, not
			// after `refreshAll()` below. Its `guardCategory` redirect (when
			// セキュリティ is no longer visible) goes through `beforeNavigate`,
			// and a still-pending guard would prompt on it. Drafts are synced
			// here directly instead of waiting for the re-sync effect above.
			resetDraftsToSaved();
			applyingAuth = false;

			// Copilot review on PR #198: `settings/+layout.ts`'s visible-category
			// snapshot (`categories`) is computed once from `sessionStore.authDisabled`
			// at load time and does NOT rerun on its own - left stale, a non-admin
			// whose auth was just re-enabled would keep seeing the セキュリティ
			// category in the nav (or the opposite: re-disabling it wouldn't restore
			// it) until some unrelated navigation happened to reload the layout.
			// `refreshAll()` reruns every load() in the hierarchy -
			// `(app)/+layout.ts` (the SessionController confirms the session again:
			// the Rust side now answers `kind: 'local'` or `'account'`) ->
			// `settings/+layout.ts` (categories, from `sessionStore.authDisabled`,
			// which is derived from that confirmation) -> this route's own
			// `+page.ts` (`guardCategory`, redirecting away if セキュリティ is no
			// longer visible) - the same chain a fresh navigation to this URL would
			// trigger. Issue #260 (S-61): `authDisabled` is no longer assigned here
			// from the save's answer; it follows the confirmed session only, so a
			// stale answer can never set it.
			await refreshAll();
		} catch (err) {
			// 排他違反（LANアクセス有効中の有効化など）はサーバ側の日本語メッセージ
			// (kind: 'other') をそのままトーストに出す（spec M11）。
			toastStore.push('error', errorMessage(err));
		} finally {
			applyingAuth = false;
		}
	}
</script>

<div class="settings-grid">
	<div class="danger-card">
		<SurfaceCard>
			<div class="card-head card-head--danger">
				<ShieldAlert size={20} aria-hidden="true" />
				<div>
					<h3>{m['settings.authDisableHeading']()}</h3>
					<p>{m['settings.authDisableDesc']()}</p>
				</div>
			</div>

			<label class="banto-switch-field">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					bind:checked={disabledDraft}
					disabled={!editable}
				/>
				{m['settings.authDisableToggle']()}
			</label>

			<div class="server-fields">
				<label class="banto-field banto-field--stacked">
					<select
						class="banto-field-control"
						bind:value={disabledRoleDraft}
						disabled={!editable || !disabledDraft}
					>
						{#each authDisabledRoleOptions as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
					<span class="banto-field-label">{m['settings.startupRole']()}</span>
				</label>
			</div>

			<p class="note">{m['settings.explicitSaveHint']()}</p>
			<div class="save-row">
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={saveAuthSettings}
					disabled={applyingAuth || !editable}
				>
					{m['settings.saveAndApply']()}
				</button>
				{#if dirty}
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						onclick={resetDraftsToSaved}
						disabled={applyingAuth}
					>
						{m['unsaved.discard']()}
					</button>
				{/if}
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
			</div>

			{#if authSettingsStore.error}
				<p class="error">{m['settings.savedValuesUnavailable']()} {authSettingsStore.error}</p>
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					onclick={retryLoad}
					disabled={reloading}
				>
					{m['common.reload']()}
				</button>
			{/if}

			{#if authSettingsStore.value}
				<p class="status">
					{m['settings.statusLabel']()}
					<strong
						>{authSettingsStore.value.disabled
							? m['settings.authDisabledOn']()
							: m['settings.authDisabledOff']()}</strong
					>
				</p>
			{/if}

			<p class="note warning">
				{m['settings.authDisableNote']()}
			</p>
		</SurfaceCard>
	</div>
</div>
