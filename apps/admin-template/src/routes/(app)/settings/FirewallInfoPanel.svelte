<script lang="ts">
	/**
	 * 「ファイアウォールの許可に必要な情報」（Issue #219 段階 1 / PR-A）。
	 * spec §11.4（LAN 設定の UX・Windows ファイアウォールの案内）。
	 * ConnectivitySection.svelte の LAN カードの中、待受状態の下に出す。
	 *
	 * 何を出すかは `firewallInfo.ts` の `firewallGuide` が決める（稼働中の
	 * listener の snapshot = `status.live` だけが入力。保存値・未保存の
	 * フォームの値は使わない）。コピーの直前に状態を読み直し、表示していた
	 * 対象（generation・ポート・待受アドレス・実行ファイル）と変わっていたら
	 * コピーせず、表示を更新して確かめ直しを促す — 画面に出ている内容と
	 * コピーする内容を常に一致させる。
	 *
	 * 文言はすべて messages 経由（conventions §13）。PowerShell のコマンド
	 * 文字列は文言ではなくコマンドの内容なので、`firewallInfo.ts` が組み立てる。
	 */
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { copyText } from '#lib/clipboard.js';
	import { getAppIdentifier, type ServerStatus } from '#lib/banto/serverAdmin.js';
	import {
		FIREWALL_DIRECTION,
		FIREWALL_PROFILE,
		FIREWALL_PROTOCOL,
		FIREWALL_REMOTE_ADDRESS,
		firewallCopyCheck,
		firewallGuide,
		type FirewallInfo
	} from './firewallInfo';
	import type { StatusRefresh } from './serverStatusRequests';
	import FirewallRuleStatusPanel from './FirewallRuleStatusPanel.svelte';

	interface Props {
		/** The last status snapshot the section loaded or applied. */
		status: ServerStatus;
		/**
		 * Re-read the status (updating the section's snapshot when it is still
		 * the latest read - see `serverStatusRequests.ts`).
		 */
		refresh: () => Promise<StatusRefresh>;
		/**
		 * The section is applying new settings. No copy starts meanwhile, and
		 * a copy already waiting for its re-read is dropped (the apply makes
		 * that read stale), so a command is never copied for a listener the
		 * apply is replacing (owner review on PR #463).
		 */
		applying: boolean;
	}

	let { status, refresh, applying }: Props = $props();

	let identifier = $state<string | null>(null);
	let identifierLoaded = $state(false);

	$effect(() => {
		untrack(() => {
			void getAppIdentifier().then((id) => {
				identifier = id;
				identifierLoaded = true;
			});
		});
	});

	const ruleExists = (name: string) => m['settings.firewallRuleExists']({ name });
	const guide = $derived(firewallGuide(status, identifier, ruleExists));

	type CopyKey =
		'exe' | 'direction' | 'protocol' | 'port' | 'profile' | 'remote' | 'program' | 'portRule';

	let copiedKey = $state<CopyKey | null>(null);
	let copyProblem = $state<'stale' | 'unavailable' | 'failed' | null>(null);
	let copying = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => () => clearTimeout(copiedTimer));

	function textFor(key: CopyKey, info: FirewallInfo): string | null {
		switch (key) {
			case 'exe':
				return info.executablePath;
			case 'direction':
				return FIREWALL_DIRECTION;
			case 'protocol':
				return FIREWALL_PROTOCOL;
			case 'port':
				return String(info.port);
			case 'profile':
				return FIREWALL_PROFILE;
			case 'remote':
				return FIREWALL_REMOTE_ADDRESS;
			case 'program':
				return info.commands?.program ?? null;
			case 'portRule':
				return info.commands?.port ?? null;
		}
	}

	async function copy(key: CopyKey): Promise<void> {
		const [current, busy] = untrack(() => [guide, copying || applying] as const);
		if (current.kind !== 'show' || busy) return;
		const shown = current.info;
		copying = true;
		copiedKey = null;
		copyProblem = null;
		try {
			const check = firewallCopyCheck(
				shown,
				await refresh(),
				untrack(() => identifier)
			);
			if (check !== 'copy') {
				copyProblem = check;
				return;
			}
			const text = textFor(key, shown);
			if (text === null) return;
			if (await copyText(text)) {
				copiedKey = key;
				clearTimeout(copiedTimer);
				copiedTimer = setTimeout(() => (copiedKey = null), 2000);
			} else {
				copyProblem = 'failed';
			}
		} finally {
			copying = false;
		}
	}
</script>

{#snippet copyButton(key: CopyKey, item: string)}
	<button
		type="button"
		class="banto-btn banto-btn--secondary firewall-copy"
		aria-label={m['settings.firewallCopyLabel']({ item })}
		onclick={() => copy(key)}
		disabled={copying || applying}
	>
		{copiedKey === key ? m['settings.firewallCopied']() : m['settings.firewallCopy']()}
	</button>
{/snippet}

{#if guide.kind === 'notNeeded'}
	<div class="firewall-info">
		<h4>{m['settings.firewallHeading']()}</h4>
		<p class="note">
			{guide.reason === 'stopped'
				? m['settings.firewallNotNeededStopped']()
				: m['settings.firewallNotNeededLocal']()}
		</p>
	</div>
{:else if guide.kind === 'show'}
	{@const info = guide.info}
	<div class="firewall-info">
		<h4>{m['settings.firewallHeading']()}</h4>
		<p class="note">{m['settings.firewallDesc']()}</p>

		<dl class="firewall-values">
			<div class="firewall-row">
				<dt>{m['settings.firewallExecutable']()}</dt>
				<dd>
					{#if info.executablePath}
						<code>{info.executablePath}</code>
						{@render copyButton('exe', m['settings.firewallExecutable']())}
					{:else}
						<span>{m['settings.firewallExecutableUnknown']()}</span>
					{/if}
				</dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.firewallDirection']()}</dt>
				<dd>
					<span>{m['settings.firewallDirectionValue']()}</span>
					<code>{FIREWALL_DIRECTION}</code>
					{@render copyButton('direction', m['settings.firewallDirection']())}
				</dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.firewallProtocol']()}</dt>
				<dd>
					<code>{FIREWALL_PROTOCOL}</code>
					{@render copyButton('protocol', m['settings.firewallProtocol']())}
				</dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.firewallPort']()}</dt>
				<dd>
					<code>{info.port}</code>
					{@render copyButton('port', m['settings.firewallPort']())}
				</dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.firewallProfile']()}</dt>
				<dd>
					<span>{m['settings.firewallProfileValue']()}</span>
					<code>{FIREWALL_PROFILE}</code>
					{@render copyButton('profile', m['settings.firewallProfile']())}
				</dd>
			</div>
			<div class="firewall-row">
				<dt>{m['settings.firewallRemote']()}</dt>
				<dd>
					<span>{m['settings.firewallRemoteValue']()}</span>
					<code>{FIREWALL_REMOTE_ADDRESS}</code>
					{@render copyButton('remote', m['settings.firewallRemote']())}
				</dd>
			</div>
		</dl>
		<p class="note">{m['settings.firewallRemoteNote']()}</p>

		<h4>{m['settings.firewallCommandsHeading']()}</h4>
		{#if info.commands}
			<p class="note">{m['settings.firewallCommandsDesc']()}</p>
			{#if info.commands.program}
				<div class="firewall-command">
					<p class="firewall-command-title">{m['settings.firewallCommandProgram']()}</p>
					<pre><code>{info.commands.program}</code></pre>
					{@render copyButton('program', m['settings.firewallCommandProgram']())}
					<p class="note">{m['settings.firewallCommandProgramNote']()}</p>
				</div>
			{/if}
			<div class="firewall-command">
				<p class="firewall-command-title">{m['settings.firewallCommandPort']()}</p>
				<pre><code>{info.commands.port}</code></pre>
				{@render copyButton('portRule', m['settings.firewallCommandPort']())}
				<p class="note">{m['settings.firewallCommandPortNote']()}</p>
			</div>
		{:else if identifierLoaded}
			<p class="note">{m['settings.firewallCommandsUnavailable']()}</p>
		{/if}

		<div role="status" aria-live="polite">
			{#if copyProblem === 'stale'}
				<p class="error">{m['settings.firewallCopyStale']()}</p>
			{:else if copyProblem === 'unavailable'}
				<p class="error">{m['settings.firewallCopyUnavailable']()}</p>
			{:else if copyProblem === 'failed'}
				<p class="error">{m['settings.firewallCopyFailed']()}</p>
			{/if}
		</div>

		<FirewallRuleStatusPanel {info} {identifier} {refresh} {applying} />

		<p class="note">{m['settings.firewallBlockNote']()}</p>
		<p class="note">{m['settings.firewallVendorNote']()}</p>
	</div>
{/if}
