<script lang="ts">
	/**
	 * サーバ・接続カテゴリ（choiapp-feedback-2026-09 §3）: LANアクセス（QR /
	 * viewer-public 含む） / システム情報。`+page.svelte` の
	 * `<section id="connectivity">` ラッパー（admin 限定）から描画される
	 * （settings-split refactor: markup/state/CSS の移動のみ、挙動は変えない）。
	 *
	 * `systemInfoStore`（systemInfoStore.svelte.ts）は DataSection.svelte の
	 * `backupPostgresDialect` からも読まれる（spec M17）。初期ロード effect は
	 * settings-routes step 2（Copilot review on PR #198）で
	 * `settings/+layout.svelte` へ移した（`/settings/data` 等への直接遷移でも
	 * この値が要るため）- エラー表示は下の `systemInfoStore.error` を直接読む。
	 */
	import { untrack } from 'svelte';
	import { isProviderError } from '@banto/admin-core';
	import { Server, Wifi } from '@lucide/svelte';
	import { UnsavedChangesNotice } from '@banto/forms';
	import * as m from '#lib/paraglide/messages.js';
	import { SurfaceCard } from '@banto/ui';
	import {
		applyServerSettings,
		getServerStatus,
		liveBind,
		type ServerStatus
	} from '#lib/banto/serverAdmin.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { formatBytes, tauri } from './shared';
	import { authSettingsStore } from './authSettingsStore.svelte';
	import { systemInfoStore } from './systemInfoStore.svelte';
	import { connectivityScope, isIpv4Bind, pickPrimaryLanUrl } from './connectivityScope';
	import FirewallInfoPanel from './FirewallInfoPanel.svelte';
	import LanReachCheckPanel from './LanReachCheckPanel.svelte';
	import { lanUiMissing, reachCheckAvailable } from './lanReachCheck';
	import { ServerStatusRequests, type StatusRefresh } from './serverStatusRequests';

	let serverStatus = $state<ServerStatus | null>(null);
	let bindDraft = $state('127.0.0.1');
	let portDraft = $state(8721);
	let enabledDraft = $state(false);
	// viewer-public-plan §3.1-6 (ADR-0012): `server.viewerPublic` toggle,
	// same draft/apply pattern as `enabledDraft`/`bindDraft`/`portDraft`
	// above - `applyServerSettings`'s 4th argument.
	let viewerPublicDraft = $state(false);
	let applying = $state(false);
	let serverError: string | null = $state(null);
	// The saved status could not be read (yet). Owner review on PR #232:
	// until it is, the drafts are only placeholders with nothing to compare
	// against, so they are NOT editable (an edit here could never be detected
	// as unsaved) - `loadError` offers a retry instead.
	let loadingStatus = $state(false);
	let loadError: string | null = $state(null);
	const editable = $derived(serverStatus !== null && !loadingStatus);

	function applyStatusToDrafts(status: ServerStatus): void {
		serverStatus = status;
		enabledDraft = status.enabled;
		bindDraft = status.bind;
		portDraft = status.port;
		viewerPublicDraft = status.viewerPublic;
	}

	// Owner review on PR #463: the status responses below can arrive out of
	// order (a slow read for the firewall copy after an apply). Every read and
	// apply goes through this, so an older response never puts the screen
	// back (`serverStatusRequests.ts`). Called from `$effect` too, so the
	// read is untracked.
	const statusRequests = new ServerStatusRequests(
		() => untrack(() => serverStatus),
		(status) => (serverStatus = status)
	);

	/** Initial load, and the retry button while it keeps failing. */
	async function loadServerStatus(): Promise<void> {
		loadingStatus = true;
		loadError = null;
		const result = await statusRequests.refresh(getServerStatus);
		if (result.kind === 'ok') {
			applyStatusToDrafts(result.status);
		} else if (result.kind === 'unavailable') {
			loadError = isProviderError(result.error) ? result.error.message : String(result.error);
		}
		loadingStatus = false;
	}

	$effect(() => {
		if (!tauri) return;
		untrack(() => void loadServerStatus());
	});

	/**
	 * Issue #219: re-read the live status for the firewall information
	 * (before it copies anything). Only `serverStatus` is replaced - like the
	 * failed-apply path below, the drafts keep what the user typed. `null`
	 * `superseded` when an apply or a newer read came after it (nothing is
	 * replaced then).
	 */
	function refreshServerStatus(): Promise<StatusRefresh> {
		return statusRequests.refresh(getServerStatus);
	}

	// Issue #214: the drafts above differ from the last loaded/applied
	// status. While the status is not loaded the inputs are disabled
	// (`editable`), so there is nothing unsaved to protect.
	const dirty = $derived(
		serverStatus !== null &&
			(enabledDraft !== serverStatus.enabled ||
				bindDraft !== serverStatus.bind ||
				portDraft !== serverStatus.port ||
				viewerPublicDraft !== serverStatus.viewerPublic)
	);
	const guard = guardUnsavedChanges({ isDirty: () => dirty, isSaving: () => applying });

	/** The "discard" button: put the drafts back to the applied status. */
	function resetDraftsToSaved(): void {
		if (serverStatus) applyStatusToDrafts(serverStatus);
	}

	async function saveAndApply(): Promise<void> {
		applying = true;
		serverError = null;
		try {
			const applied = await statusRequests.apply(() =>
				applyServerSettings(enabledDraft, bindDraft, portDraft, viewerPublicDraft)
			);
			if (applied) applyStatusToDrafts(applied);
		} catch (err) {
			serverError = isProviderError(err) ? err.message : String(err);
			// Issue #287: a failed apply may have stopped/restarted the server
			// (the backend rolls back to the previous saved settings), so the
			// status shown is stale. Re-read the real one. Only `serverStatus`
			// is replaced - the drafts keep what the user typed, so they can
			// fix the value (e.g. a port in use) and retry; "変更を破棄" then
			// resets them to this actual status.
			// An unavailable/superseded read keeps the previous status; the error
			// above is already shown.
			await statusRequests.refresh(getServerStatus);
		} finally {
			applying = false;
		}
	}

	// The QR code shown is for the first LAN-reachable URL - that's the one
	// another machine on the LAN would actually need to scan; showing every
	// URL's QR would just be noise. `serverStatus.urls` is already scoped to
	// `bind` on the Rust side (`banto_server::lan_urls_for_bind`), so a
	// loopback-scoped bind's `urls` only ever contains a loopback entry and
	// `pickPrimaryLanUrl` naturally returns `null` for it.
	//
	// Owner review on PR #254 (P2, 2nd round): this used to pick
	// `urls.find((url) => !url.includes('127.0.0.1'))`, a substring check
	// that disagreed with `scope` below (computed with a real loopback test)
	// for any bind outside the literal string `"127.0.0.1"` - e.g. a
	// `127.0.0.2` bind reads as `scope === 'local'` but that check still
	// picked its URL as "the LAN one" for the QR. `pickPrimaryLanUrl` uses
	// the same `isLoopbackHost` test `connectivityScope` does
	// (`connectivityScope.ts`), so the two can no longer disagree.
	const firstLanUrl = $derived(serverStatus ? pickPrimaryLanUrl(serverStatus.urls) : null);
	const firstLanQrSvg = $derived(
		firstLanUrl
			? (serverStatus?.qrSvgs.find((entry) => entry.url === firstLanUrl)?.svg ?? null)
			: null
	);

	// Issue #216: how far the *currently applied* bind reaches, driving the
	// "running, this PC only" vs. "running, reachable from the LAN" status
	// wording below. Deliberately reads the status (the last loaded/applied
	// value), not `bindDraft` - an unsaved draft change must not change what
	// the status line claims about the server that is actually running.
	// Issue #459: the live listener's bind (`liveBind`), not the saved one.
	//
	// Owner decision, 2026-09-29 (PR #254 review, 4th round): IPv6 binds are
	// out of scope for URL/QR guidance for now (see `connectivityScope.ts`'s
	// module doc) - `isBindIpv4` gates the normal local/LAN status line and
	// the URLs/QR block; an IPv6 bind shows a dedicated "not guided" message
	// instead (`settings.ipv6NotGuidedRunning`/`settings.ipv6NotGuidedNote`).
	const statusBind = $derived(serverStatus ? liveBind(serverStatus) : null);
	const isBindIpv4 = $derived(statusBind !== null ? isIpv4Bind(statusBind) : true);
	const scope = $derived(statusBind !== null && isBindIpv4 ? connectivityScope(statusBind) : null);

	// --- System Info (M-review 2026-08 §2.4, Tauri + LAN browser, admin only)
	// Read-only diagnostics: version, migration version, DB dialect+latency,
	// uptime, active LAN sessions, attachment storage. Same availability gate
	// as the audit/backups sections (real backend, not the plain-browser demo,
	// which has no live server to probe). Loaded by `settings/+layout.svelte`
	// (Copilot review on PR #198) rather than here - see `systemInfoStore.svelte.ts`'s
	// doc comment - so `systemInfoStore.error` below is written by that effect.
</script>

{#snippet reachQr(svg: string)}
	<!-- Issue #219 PR-C3: the reach-check URL's QR SVG, made by the server
	     (Rust `qrcode` crate via `reach_check_issue`), not user input. Drawn
	     here so `{@html}` stays in this allowlisted file (conventions §7). -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<div class="qr">{@html svg}</div>
{/snippet}

<div class="settings-grid">
	<SurfaceCard>
		<div class="card-head">
			<Wifi size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.lanHeading']()}</h3>
				<p>{m['settings.lanDesc']()}</p>
			</div>
		</div>
		{#if tauri}
			<!-- viewer-public-plan §3.1-6 (ADR-0012): the opt-in that lets
			     "auth disabled + LAN enabled" pass validation at all (§2.3).
			     Shown above the LAN toggle so the dependency reads top to
			     bottom - check this, then the toggle below unlocks. -->
			<label class="banto-switch-field">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					bind:checked={viewerPublicDraft}
					disabled={!editable}
				/>
				{m['settings.viewerPublicToggle']()}
			</label>
			<p class="note warning">{m['settings.viewerPublicNote']()}</p>

			<label class="banto-switch-field">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					bind:checked={enabledDraft}
					disabled={!editable || (authSettingsStore.value?.disabled && !viewerPublicDraft)}
				/>
				{m['settings.lanToggle']()}
			</label>
			{#if authSettingsStore.value?.disabled}
				<p class="note">{m['settings.lanDisabledByAuth']()}</p>
			{/if}

			<div class="server-fields">
				<label class="banto-field banto-field--stacked">
					<select class="banto-field-control" bind:value={bindDraft} disabled={!editable}>
						<option value="127.0.0.1">{m['settings.bindLocalOnly']()}</option>
						<option value="0.0.0.0">{m['settings.bindLanPublic']()}</option>
					</select>
					<span class="banto-field-label">{m['settings.bindAddress']()}</span>
				</label>

				<label class="banto-field">
					<input
						class="banto-field-control"
						type="number"
						placeholder=" "
						min="1"
						max="65535"
						bind:value={portDraft}
						disabled={!editable}
					/>
					<span class="banto-field-label">{m['settings.port']()}</span>
				</label>
			</div>

			{#if loadError}
				<p class="error">{m['settings.savedValuesUnavailable']()} {loadError}</p>
				<button
					type="button"
					class="banto-btn banto-btn--secondary"
					onclick={loadServerStatus}
					disabled={loadingStatus}
				>
					{m['common.reload']()}
				</button>
			{/if}

			<p class="note">{m['settings.explicitSaveHint']()}</p>
			<div class="save-row">
				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={saveAndApply}
					disabled={applying || !editable}
				>
					{m['settings.saveAndApply']()}
				</button>
				{#if dirty}
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						onclick={resetDraftsToSaved}
						disabled={applying}
					>
						{m['unsaved.discard']()}
					</button>
				{/if}
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
			</div>

			{#if serverError}
				<p class="error">{serverError}</p>
			{/if}

			{#if serverStatus}
				<!-- Issue #216: the status wording says how far the running
				     server actually reaches (`scope`, derived from the applied
				     `bind`), not just whether it is running - a loopback bind
				     must read as "this PC only", never as LAN-reachable.
				     Owner decision, 2026-09-29: an IPv6 bind reads as its own
				     "not guided" wording instead of local/LAN (`isBindIpv4`). -->
				<p class="status">
					{m['settings.statusLabel']()}
					<strong>
						{#if !serverStatus.running}
							{m['settings.stopped']()}
						{:else if !isBindIpv4}
							{m['settings.ipv6NotGuidedRunning']()}
						{:else if scope === 'local'}
							{m['settings.scopeLocalRunning']()}
						{:else}
							{m['settings.scopeLanRunning']()}
						{/if}
					</strong>
				</p>
				{#if serverStatus.running && !isBindIpv4}
					<!-- Owner decision, 2026-09-29: IPv6 binds are out of scope
					     for URL/QR guidance for now (connectivityScope.ts's
					     module doc has the reasoning) - `serverStatus.urls` is
					     always empty for one, so show an explanatory note
					     instead of an empty list. -->
					<p class="note">{m['settings.ipv6NotGuidedNote']()}</p>
				{:else if lanUiMissing(serverStatus)}
					<!-- Issue #478: a build without the embedded web UI serves
					     only a placeholder to other devices, so no URL, QR or
					     connection check (lanReachCheck.ts `lanUiMissing`). -->
					<p class="note" data-lan-ui-missing>{m['settings.lanUiNotEmbedded']()}</p>
				{:else if serverStatus.running}
					<ul class="urls">
						{#each serverStatus.urls as url (url)}
							<li><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
						{/each}
					</ul>
					{#if scope === 'lan'}
						<!-- LAN reachability is never guaranteed: firewalls, VPNs,
						     or router client-isolation can still block it even
						     though the server is listening on a non-loopback
						     address (Issue #216 completion condition). -->
						<p class="note">{m['settings.lanReachabilityNote']()}</p>
					{/if}
					{#if firstLanQrSvg}
						<!-- Server-generated QR SVG (Rust `qrcode` crate), not user input. -->
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="qr">{@html firstLanQrSvg}</div>
					{/if}
				{/if}
				<!-- Issue #219: what a firewall rule for the LIVE listener needs
				     (Windows only; "not needed" while stopped or loopback-only). -->
				<FirewallInfoPanel status={serverStatus} refresh={refreshServerStatus} {applying} />
				<!-- Issue #219 PR-C3: whether another device actually reached the
				     live listener - its own block, apart from the firewall ones
				     (lan-reach-check-design §4.1). Not Windows-only. -->
				{#if reachCheckAvailable(serverStatus)}
					<LanReachCheckPanel
						status={serverStatus}
						refresh={refreshServerStatus}
						{applying}
						qr={reachQr}
					/>
				{/if}
			{/if}
		{:else}
			<p class="note">{m['settings.serverDesktopOnly']()}</p>
		{/if}
		<p class="note">
			{m['settings.lanNote']()}
		</p>
	</SurfaceCard>

	{#if systemInfoStore.available}
		<SurfaceCard>
			<div class="card-head">
				<Server size={20} aria-hidden="true" />
				<div>
					<h3>{m['settings.systemInfoHeading']()}</h3>
					<p>{m['settings.systemInfoDesc']()}</p>
				</div>
			</div>

			{#if systemInfoStore.error}
				<p class="error">{systemInfoStore.error}</p>
			{:else if systemInfoStore.value}
				<p class="status">
					{m['settings.systemInfoAppVersion']()} <strong>{systemInfoStore.value.appVersion}</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoMigration']()}
					<strong>{systemInfoStore.value.migrationVersion ?? '—'}</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoDatabase']()}
					<strong>
						{systemInfoStore.value.dbDialect} ({m['settings.systemInfoLatencyValue']({
							ms: systemInfoStore.value.dbLatencyMs.toFixed(1)
						})})
					</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoUptime']()}
					<strong
						>{m['settings.systemInfoUptimeValue']({
							secs: systemInfoStore.value.uptimeSecs
						})}</strong
					>
				</p>
				<p class="status">
					{m['settings.systemInfoSessions']()}
					<strong>{systemInfoStore.value.activeSessions}</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoStorage']()}
					<strong>
						{systemInfoStore.value.attachmentBytes === null
							? '—'
							: formatBytes(systemInfoStore.value.attachmentBytes)}
					</strong>
				</p>
				{#if systemInfoStore.value.metrics}
					<p class="status">
						{m['settings.systemInfoHostCpu']()}
						<strong>
							{m['settings.systemInfoHostCpuValue']({
								percent: systemInfoStore.value.metrics.hostCpuPercent.toFixed(1),
								count: systemInfoStore.value.metrics.cpuCount
							})}
						</strong>
					</p>
					<p class="status">
						{m['settings.systemInfoHostMemory']()}
						<strong>
							{m['settings.systemInfoMemoryValue']({
								used: formatBytes(systemInfoStore.value.metrics.hostMemoryUsedBytes),
								total: formatBytes(systemInfoStore.value.metrics.hostMemoryTotalBytes)
							})}
						</strong>
					</p>
					{#if systemInfoStore.value.metrics.hostSwapTotalBytes > 0}
						<p class="status">
							{m['settings.systemInfoSwap']()}
							<strong>
								{m['settings.systemInfoMemoryValue']({
									used: formatBytes(systemInfoStore.value.metrics.hostSwapUsedBytes),
									total: formatBytes(systemInfoStore.value.metrics.hostSwapTotalBytes)
								})}
							</strong>
						</p>
					{/if}
					<p class="status">
						{m['settings.systemInfoProcess']()}
						<strong>
							{m['settings.systemInfoProcessValue']({
								percent: systemInfoStore.value.metrics.processCpuPercent.toFixed(1),
								rss: formatBytes(systemInfoStore.value.metrics.processMemoryBytes)
							})}
						</strong>
					</p>
				{/if}
			{:else}
				<p class="note">{m['settings.systemInfoLoading']()}</p>
			{/if}

			<p class="note">{m['settings.systemInfoNote']()}</p>
		</SurfaceCard>
	{/if}
</div>
