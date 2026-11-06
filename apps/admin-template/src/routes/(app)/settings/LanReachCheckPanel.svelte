<script lang="ts">
	/**
	 * 「別の端末からの接続確認」（Issue #219 段階 1 / PR-C3）。
	 * spec §11.4（LAN 設定の UX）、lan-reach-check-design §4.1・§4.2・D9・D10。
	 * ConnectivitySection.svelte の LAN カードの中、ファイアウォールの欄とは
	 * 別の欄として出す（ファイアウォールの状態から結果を推測しない・結果から
	 * ファイアウォールの状態を推測しない）。
	 *
	 * 稼働中の待受の LAN の URL の候補からホストを選んで「確認用の URL を
	 * 発行」→ URL と QR と残り時間。確認待ちの間だけ 2 秒おきに状態を読み直し、
	 * 確認済み（時刻・接続元 IP・使った URL と「その時点・その端末」の注記）・
	 * 古い（1 時間）・このPC自身・期限切れ（届かないとは断定しない）・
	 * 読めない（「未確認」にしない）を出し分ける。要求の順序と generation の
	 * 照合・読み直しの間隔は `lanReachCheckController.svelte.ts`、状態の判定は
	 * `lanReachCheck.ts`。
	 *
	 * QR の SVG はサーバー（Rust の `qrcode` クレート）が作ったもので、
	 * conventions §7 の許可リストにある ConnectivitySection.svelte が描く
	 * （`qr` snippet）。文言はすべて messages 経由（conventions §13）。
	 */
	import { untrack, type Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { copyText } from '#lib/clipboard.js';
	import {
		getReachCheckStatus,
		issueReachCheck,
		type ReachCheckRefusal,
		type ReachRecord,
		type ServerStatus
	} from '#lib/banto/serverAdmin.js';
	import {
		formatRemaining,
		minutesSince,
		reachCandidateHosts,
		recordUrl,
		type IssuedReachUrl
	} from './lanReachCheck';
	import { ReachCheckController } from './lanReachCheckController.svelte';
	import type { StatusRefresh } from './serverStatusRequests';

	interface Props {
		/** The live server snapshot (shown only when `reachCheckAvailable`). */
		status: ServerStatus;
		/** Re-read the server status (when the host is already past `status`). */
		refresh: () => Promise<StatusRefresh>;
		/** The section is applying new settings: nothing is issued, pending answers are dropped. */
		applying: boolean;
		/** Renders the server-made QR SVG (drawn by ConnectivitySection, the file conventions §7 allows to). */
		qr: Snippet<[string]>;
	}

	let { status, refresh, applying, qr }: Props = $props();

	const controller = new ReachCheckController({
		getStatus: getReachCheckStatus,
		issue: issueReachCheck,
		refreshServer: () => void refresh()
	});

	const generation = $derived(status.generation ?? 0);

	// The listener changing (a new generation) discards what is shown and
	// reads again; an apply suspends everything until it is over.
	$effect(() => {
		const shown = generation;
		if (applying) {
			untrack(() => controller.suspend());
			return;
		}
		untrack(() => controller.target(shown));
	});

	// Leaving the page stops the re-read interval (design D9).
	$effect(() => () => controller.dispose());

	const hosts = $derived(reachCandidateHosts(status));
	let hostChoice = $state<string | null>(null);
	const host = $derived(
		hostChoice !== null && hosts.includes(hostChoice) ? hostChoice : (hosts[0] ?? null)
	);

	const view = $derived(controller.view);

	let copied = $state<'ok' | 'failed' | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(copiedTimer));

	async function copyUrl(issued: IssuedReachUrl): Promise<void> {
		copied = (await copyText(issued.url)) ? 'ok' : 'failed';
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = null), 2000);
	}

	function issue(): void {
		if (host !== null) void controller.issue(host);
	}

	function formatTime(at: number): string {
		return new Date(at).toLocaleString(getLocale());
	}

	function refusalText(reason: ReachCheckRefusal): string {
		switch (reason) {
			case 'notListening':
				return m['settings.reachRefusedNotListening']();
			case 'unsupportedBind':
				return m['settings.reachRefusedUnsupportedBind']();
			case 'loopbackOnly':
				return m['settings.reachRefusedLoopbackOnly']();
			case 'unknownHost':
				return m['settings.reachRefusedUnknownHost']();
			case 'staleGeneration':
				return m['settings.reachRefusedStaleGeneration']();
			case 'localAddressesUnavailable':
				return m['settings.reachRefusedLocalAddressesUnavailable']();
			default:
				return m['settings.reachIssueFailed']();
		}
	}
</script>

{#snippet issuedUrl(issued: IssuedReachUrl | null, remainingMs: number)}
	<p class="reach-remaining">
		{m['settings.reachRemaining']({ time: formatRemaining(remainingMs) })}
	</p>
	{#if issued}
		<div class="reach-url">
			<code>{issued.url}</code>
			<button
				type="button"
				class="banto-btn banto-btn--secondary firewall-copy"
				onclick={() => copyUrl(issued)}
			>
				{copied === 'ok' ? m['settings.reachCopied']() : m['settings.reachCopyUrl']()}
			</button>
		</div>
		{#if copied === 'failed'}
			<p class="error">{m['settings.reachCopyFailed']()}</p>
		{/if}
		{@render qr(issued.qrSvg)}
	{:else}
		<p class="note">{m['settings.reachPendingNoUrl']()}</p>
	{/if}
{/snippet}

{#snippet recordList(records: ReachRecord[], now: number)}
	{#each records as record, index (`${record.issueId}-${record.at}`)}
		{#if index === 1}
			<p class="note">{m['settings.reachOtherRecords']()}</p>
		{/if}
		<dl class="firewall-values reach-record" data-reach-record={index === 0 ? 'latest' : 'older'}>
			<div class="firewall-row">
				<dt>{m['settings.reachRecordAt']()}</dt>
				<dd>
					{m['settings.reachRecordAtValue']({
						time: formatTime(record.at),
						minutes: minutesSince(record.at, now)
					})}
				</dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.reachRecordPeer']()}</dt>
				<dd><code>{record.peerIp}</code></dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.reachRecordUrl']()}</dt>
				<dd><code>{recordUrl(record)}</code></dd>
			</div>
		</dl>
	{/each}
{/snippet}

<div class="reach-check">
	<h4>{m['settings.reachHeading']()}</h4>
	<p class="note">{m['settings.reachDesc']()}</p>

	<div class="reach-state" role="status" aria-live="polite" data-reach-state={view.kind}>
		{#if view.kind === 'loading'}
			<p class="note">{m['settings.reachLoading']()}</p>
		{:else if view.kind === 'unreadable'}
			<p class="error">{m['settings.reachUnreadable']()}</p>
		{:else if view.kind === 'unverified'}
			<p>{m['settings.reachUnverified']()}</p>
		{:else if view.kind === 'pending'}
			<p>{m['settings.reachPending']()}</p>
			{@render issuedUrl(view.issued, view.remainingMs)}
		{:else if view.kind === 'selfAccess'}
			<p class="error">{m['settings.reachSelfAccess']({ time: formatTime(view.at) })}</p>
			<p>{m['settings.reachPending']()}</p>
			{@render issuedUrl(view.issued, view.remainingMs)}
		{:else if view.kind === 'verified' || view.kind === 'stale'}
			<p class:reach-verified={view.kind === 'verified'}>
				{m['settings.reachVerified']()}
			</p>
			{#if view.kind === 'stale'}
				<p class="note">{m['settings.reachStale']()}</p>
			{/if}
			<div class:reach-dim={view.kind === 'stale'}>
				{@render recordList(view.records, controller.now)}
			</div>
			<p class="note">{m['settings.reachVerifiedNote']()}</p>
		{:else if view.kind === 'expired'}
			<p>{m['settings.reachExpired']()}</p>
			<p class="note">{m['settings.reachExpiredNote']()}</p>
			<ul class="reach-hints">
				<li>{m['settings.reachHintNetwork']()}</li>
				<li>{m['settings.reachHintFirewall']()}</li>
				<li>{m['settings.reachHintVendor']()}</li>
				<li>{m['settings.reachHintIsolation']()}</li>
			</ul>
		{/if}

		{#if controller.issueProblem?.kind === 'refused'}
			<p class="error" data-reach-refusal={controller.issueProblem.reason}>
				{refusalText(controller.issueProblem.reason)}
			</p>
		{:else if controller.issueProblem?.kind === 'changed'}
			<p class="error">{m['settings.reachChanged']()}</p>
		{:else if controller.issueProblem?.kind === 'failed'}
			<p class="error">
				{m['settings.reachIssueFailed']()}
				{controller.issueProblem.message ?? ''}
			</p>
		{/if}
	</div>

	{#if hosts.length > 0}
		<div class="reach-issue">
			{#if hosts.length > 1}
				<label class="banto-field banto-field--stacked">
					<select
						class="banto-field-control"
						value={host}
						onchange={(event) => (hostChoice = event.currentTarget.value)}
						disabled={applying || controller.issuing}
					>
						{#each hosts as candidate (candidate)}
							<option value={candidate}>{candidate}</option>
						{/each}
					</select>
					<span class="banto-field-label">{m['settings.reachHost']()}</span>
				</label>
			{/if}
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={issue}
				disabled={applying || controller.issuing || host === null}
			>
				{controller.issuing ? m['settings.reachIssuing']() : m['settings.reachIssue']()}
			</button>
			{#if view.kind === 'unreadable'}
				<button
					type="button"
					class="banto-btn banto-btn--ghost"
					onclick={() => controller.read()}
					disabled={applying}
				>
					{m['common.reload']()}
				</button>
			{/if}
		</div>
	{/if}

	<p class="note">{m['settings.reachScopeNote']()}</p>
</div>
