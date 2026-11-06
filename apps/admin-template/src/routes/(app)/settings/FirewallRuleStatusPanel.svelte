<script lang="ts">
	/**
	 * 「Windows ファイアウォールの状態」（Issue #219 段階 1 / PR-B）。
	 * spec §11.4（LAN 設定の UX・Windows ファイアウォールの案内）。
	 * FirewallInfoPanel.svelte の中、管理者向けのコマンドの下に出す。
	 *
	 * `firewall_rule_status` で、上のコマンドが作るルール（決まった名前）が
	 * Windows ファイアウォールにあるかを読み取りだけで確かめ、形ごとに
	 * 「ルール無し」「あり（期待どおり）」「あり（内容は期待どおり。ただし適用されていない）」
	 * 「あり（期待と違う: 項目）」
	 * 「確認できない（理由）」を出す。ルールがあることと LAN から接続できる
	 * ことは同じではないので、そのことも書く。
	 *
	 * 照合するのは ActiveStore の（効いている）ルール。ActiveStore にあっても
	 * 適用されているとは限らないので、EnforcementStatus が Full のときだけ
	 * 「適用されている」、ほかの既知の値は「存在するが適用されていない（理由）」、
	 * 読めない・未知の値は「適用状態は不明」と分けて出す。出どころがローカルの
	 * ストアでなければ種別（グループポリシー・MDM・Dynamic など）と出どころを、
	 * 取得できなければ「出どころ不明」を、ローカルのルールが無い・値が違う・
	 * 読めないときはそれを補足で出す（PR #465 の Codex・オーナーの指摘）。
	 *
	 * 再確認が失敗したら前回の結果は消す（エラーと並べて古い結果を出さない）。
	 *
	 * 応答は `firewallRuleStatus.ts` の `FirewallStatusRequests` で順序を
	 * 守る: 適用の開始・新しい確認で古い確認を捨て、表示している snapshot
	 * （generation・ポート・実行ファイル）と照合した結果だけを出す。
	 *
	 * 段階 2（ADR-0021 E3）: admin には、表示している読み取り結果に応じて
	 * 「許可する」「許可を外す」を出す（`firewallChange.ts` の
	 * `firewallChangeActions`）。押すと確認画面（FirewallChangeDialog.svelte）を
	 * 出し、承認で `firewall_rule_change` を、そのとき表示していた
	 * `expected.executablePath` と `generation` 付きで呼ぶ（決定 13）。実行中は
	 * ボタンを止め、Windows の確認（UAC）を待っている旨を出す。結果は
	 * `firewallChangeView` の文言で出し、結果に付いて返る読み直しで状態の表示を
	 * 置き換える（決定 11。表示している snapshot と照合できたときだけ）。
	 * 完了（終了コード 0）でも「接続できる」とは言わず、到達確認を促す。
	 * この欄はデスクトップ（Tauri）の LAN 設定の中にしか出ない
	 * （ConnectivitySection.svelte）。
	 *
	 * 文言はすべて messages 経由（conventions §13）。
	 */
	import { untrack } from 'svelte';
	import { isProviderError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { isAdmin } from '#lib/permissions.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import {
		changeFirewallRule,
		getFirewallRuleStatus,
		type FirewallChangeOperation,
		type FirewallEnforcement,
		type FirewallField,
		type FirewallRuleCheck,
		type FirewallRuleStatus,
		type FirewallUnknownReason
	} from '#lib/banto/serverAdmin.js';
	import { firewallRuleNames, type FirewallInfo } from './firewallInfo';
	import {
		FirewallStatusRequests,
		firewallChangeFollowUp,
		firewallFieldValue,
		firewallRuleView,
		firewallStatusMatches,
		nextFirewallPanelState,
		type FirewallCheckOutcome,
		type FirewallOriginView
	} from './firewallRuleStatus';
	import {
		firewallChangeActions,
		firewallChangeManualHints,
		firewallChangeTarget,
		firewallChangeView,
		isFirewallChangeResult,
		type FirewallChangeView
	} from './firewallChange';
	import type { StatusRefresh } from './serverStatusRequests';
	import FirewallChangeDialog from './FirewallChangeDialog.svelte';

	interface Props {
		/** The live snapshot the firewall block shows. */
		info: FirewallInfo;
		/** The Tauri bundle identifier (`null` until known or when unavailable). */
		identifier: string | null;
		/** Re-read the server status (when the host is already past `info`). */
		refresh: () => Promise<StatusRefresh>;
		/** The section is applying new settings: pending checks are dropped. */
		applying: boolean;
	}

	let { info, identifier, refresh, applying }: Props = $props();

	const requests = new FirewallStatusRequests();
	let result = $state<FirewallRuleStatus | null>(null);
	let checking = $state(false);
	let problem = $state<'unavailable' | 'changed' | null>(null);

	// Only a result compared with what is shown now is ever displayed.
	const shown = $derived(result !== null && firewallStatusMatches(info, result) ? result : null);
	const target = $derived(`${info.generation}|${info.port}|${info.executablePath ?? ''}`);

	async function check(): Promise<void> {
		checking = true;
		problem = null;
		const outcome = await requests.check(getFirewallRuleStatus, () => untrack(() => info));
		if (outcome.kind === 'superseded') return;
		checking = false;
		// A failed check clears the previous result (never shown next to the error).
		const next = nextFirewallPanelState({ result, problem }, outcome);
		result = next.result;
		problem = next.problem;
		// The status re-read changes `info`, and the effect below checks again.
		if (next.refresh) void refresh();
	}

	$effect(() => {
		void target;
		if (applying) {
			untrack(() => requests.invalidate());
			return;
		}
		untrack(() => void check());
	});

	const names = $derived(identifier === null ? null : firewallRuleNames(identifier));

	// --- Stage 2 (ADR-0021 E3): allow / remove through the elevated helper.

	/** The confirmation screen: the operation and the read it was opened for. */
	let confirming = $state<{
		operation: FirewallChangeOperation;
		status: FirewallRuleStatus;
	} | null>(null);
	/** The change waiting for UAC and the helper (`null` = none). */
	let changing = $state<FirewallChangeOperation | null>(null);
	let changeView = $state<FirewallChangeView | null>(null);
	let changeOutcome = $state<string | null>(null);
	let changeProblem = $state<'denied' | 'unavailable' | null>(null);

	const actions = $derived(
		shown
			? firewallChangeActions({
					admin: isAdmin(sessionStore.role),
					status: shown,
					ruleName: names?.programName ?? null
				})
			: []
	);

	function confirm(operation: FirewallChangeOperation): void {
		if (shown === null || changing !== null) return;
		confirming = { operation, status: shown };
	}

	async function change(): Promise<void> {
		const asked = confirming;
		confirming = null;
		if (asked === null || changing !== null) return;
		changing = asked.operation;
		changeView = null;
		changeOutcome = null;
		changeProblem = null;
		let value: unknown = null;
		let outcome: FirewallCheckOutcome = { kind: 'superseded' };
		try {
			// The target is the read the confirmation screen showed (decision 13).
			// The change runs in the checks' order: an apply or a check started
			// while it waits drops its read (owner review on PR #475).
			({ value, outcome } = await requests.change<unknown>(
				() => changeFirewallRule(asked.operation, firewallChangeTarget(asked.status)),
				(answer) => (isFirewallChangeResult(answer) ? answer.status : null),
				() => untrack(() => info)
			));
		} catch (err) {
			const kind = isProviderError(err) ? err.body.kind : null;
			changeProblem = kind === 'forbidden' || kind === 'unauthorized' ? 'denied' : 'unavailable';
		} finally {
			changing = null;
		}
		if (!isFirewallChangeResult(value)) {
			changeProblem ??= 'unavailable';
			void check();
			return;
		}
		// The outcome is shown whatever the read it carries came to.
		changeView = firewallChangeView(value);
		changeOutcome = value.outcome;
		// Every answer carries a fresh read (decision 11). It replaces what is
		// shown through the same comparison as a check - unless an apply or a
		// newer check took over. That check may have read before the helper
		// changed the rule, so read again once the change is done (or leave it
		// to the check after the apply); the outcome text stays.
		const follow = firewallChangeFollowUp(
			outcome,
			untrack(() => applying)
		);
		if (follow === 'recheck') void check();
		if (follow !== 'show') return;
		checking = false;
		const next = nextFirewallPanelState({ result, problem }, outcome);
		result = next.result;
		problem = next.problem;
		if (next.refresh) void refresh();
	}

	function fieldLabel(field: FirewallField): string {
		switch (field) {
			case 'enabled':
				return m['settings.firewallFieldEnabled']();
			case 'direction':
				return m['settings.firewallFieldDirection']();
			case 'action':
				return m['settings.firewallFieldAction']();
			case 'protocol':
				return m['settings.firewallFieldProtocol']();
			case 'profile':
				return m['settings.firewallFieldProfile']();
			case 'program':
				return m['settings.firewallFieldProgram']();
			case 'localPort':
				return m['settings.firewallFieldLocalPort']();
			case 'remoteAddress':
				return m['settings.firewallFieldRemoteAddress']();
			case 'active':
				return m['settings.firewallFieldActive']();
			case 'enforcement':
				return m['settings.firewallFieldEnforcement']();
		}
	}

	function originKind(origin: FirewallOriginView): string {
		const sourceType = origin.sourceType ?? '';
		switch (origin.kind) {
			case 'groupPolicy':
				return m['settings.firewallSourceGroupPolicy']();
			case 'mdm':
				return m['settings.firewallSourceMdm']();
			case 'dynamic':
				return m['settings.firewallSourceDynamic']();
			case 'generated':
				return m['settings.firewallSourceGenerated']();
			case 'hardcoded':
				return m['settings.firewallSourceHardcoded']();
			case 'hostFirewallLocal':
			case 'hostFirewallGroupPolicy':
			case 'hostFirewallDynamic':
			case 'hostFirewallMdm':
				return m['settings.firewallSourceHostFirewall']({ sourceType });
			case 'other':
			case 'unknown':
				return m['settings.firewallSourceOther']({ sourceType });
		}
	}

	function originText(origin: FirewallOriginView): string {
		const source = origin.source ?? m['settings.firewallSourceUnknown']();
		if (origin.kind === 'unknown') return m['settings.firewallStatusOriginUnknown']({ source });
		const kind = originKind(origin);
		return origin.policy
			? m['settings.firewallStatusPolicy']({ kind, source })
			: m['settings.firewallStatusOrigin']({ kind, source });
	}

	function notEnforcedText(enforcement: FirewallEnforcement | null): string {
		const reasons =
			enforcement?.state === 'notEnforced'
				? enforcement.reasons.join(m['settings.firewallListSeparator']())
				: m['settings.firewallSourceUnknown']();
		return m['settings.firewallEnforcementNotEnforced']({ reasons });
	}

	function reasonText(reason: FirewallUnknownReason): string {
		switch (reason) {
			case 'notWindows':
				return m['settings.firewallReasonNotWindows']();
			case 'invalidIdentifier':
				return m['settings.firewallReasonInvalidIdentifier']();
			case 'launchFailed':
				return m['settings.firewallReasonLaunchFailed']();
			case 'timeout':
				return m['settings.firewallReasonTimeout']();
			case 'queryFailed':
				return m['settings.firewallReasonQueryFailed']();
			case 'unreadableOutput':
				return m['settings.firewallReasonUnreadableOutput']();
		}
	}
</script>

{#snippet ruleStatus(title: string, name: string | null, check: FirewallRuleCheck)}
	{@const view = firewallRuleView(check)}
	<div class="firewall-rule-status" data-state={view.kind}>
		<p class="firewall-command-title">
			{title}
			{#if name}<code>{name}</code>{/if}
		</p>
		{#if view.kind === 'missing'}
			<p>{m['settings.firewallStatusMissing']()}</p>
		{:else if view.kind === 'matches'}
			<p>{m['settings.firewallStatusMatches']()}</p>
		{:else if view.kind === 'unconfirmed'}
			<p class="error">{m['settings.firewallStatusUnconfirmed']()}</p>
		{:else if view.kind === 'notEnforced'}
			<p class="caution">{m['settings.firewallStatusNotEnforced']()}</p>
			<p class="note" data-enforcement="notEnforced">{notEnforcedText(view.enforcement)}</p>
			{#if view.reasons.includes('CategoryOff')}
				<p class="note" data-enforcement-reason="CategoryOff">
					{m['settings.firewallEnforcementCategoryOff']()}
				</p>
			{/if}
		{:else if view.kind === 'differs'}
			<p class="error">{m['settings.firewallStatusDiffers']()}</p>
			<ul>
				{#each view.fields as field (field)}
					{@const value = firewallFieldValue(check, field)}
					<li>
						{fieldLabel(field)}:
						{#if field === 'active'}
							{m['settings.firewallFieldActiveNo']()}
						{:else if field === 'enforcement'}
							{notEnforcedText(view.enforcement)}
						{:else}
							<code>{value}</code>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p>{m['settings.firewallStatusUnknown']({ reason: reasonText(view.reason) })}</p>
		{/if}
		{#if view.kind === 'matches' || view.kind === 'unconfirmed' || view.kind === 'notEnforced' || view.kind === 'differs'}
			{#if view.enforcement?.state === 'enforced'}
				<p class="note" data-enforcement="enforced">
					{m['settings.firewallEnforcementEnforced']()}
				</p>
			{:else if view.enforcement?.state === 'unknown'}
				<p class="note" data-enforcement="unknown">
					{view.enforcement.values.length > 0
						? m['settings.firewallEnforcementUnknown']({
								values: view.enforcement.values.join(', ')
							})
						: m['settings.firewallEnforcementUnread']()}
				</p>
			{/if}
			{#if view.origin}
				<p
					class="note"
					data-origin={view.origin.kind === 'unknown'
						? 'unknown'
						: view.origin.policy
							? 'policy'
							: 'other'}
				>
					{originText(view.origin)}
				</p>
			{/if}
			{#if view.local.kind === 'missing'}
				<p class="note" data-local="missing">{m['settings.firewallStatusLocalMissing']()}</p>
			{:else if view.local.kind === 'differs'}
				<p class="note" data-local="differs">{m['settings.firewallStatusLocalDiffers']()}</p>
				<ul>
					{#each view.local.values as local (local.field)}
						<li>{fieldLabel(local.field)}: <code>{local.value}</code></li>
					{/each}
				</ul>
			{:else if view.local.kind === 'unknown'}
				<p class="note" data-local="unknown">{m['settings.firewallStatusLocalUnknown']()}</p>
			{/if}
			{#if view.unchecked.length > 0}
				<p class="note">
					{m['settings.firewallStatusUnchecked']({
						fields: view.unchecked.map(fieldLabel).join(m['settings.firewallListSeparator']())
					})}
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

<div class="firewall-status">
	<h4>{m['settings.firewallStatusHeading']()}</h4>
	<p class="note">{m['settings.firewallStatusDesc']()}</p>

	<div role="status" aria-live="polite">
		{#if shown}
			{@render ruleStatus(
				m['settings.firewallStatusRuleProgram'](),
				names?.programName ?? null,
				shown.program
			)}
			{@render ruleStatus(
				m['settings.firewallStatusRulePort'](),
				names?.portName ?? null,
				shown.port
			)}
			{#if shown.groupOtherRules !== null && shown.groupOtherRules > 0 && names}
				<p class="note">
					{m['settings.firewallStatusGroupOther']({
						group: names.group,
						count: shown.groupOtherRules
					})}
				</p>
			{:else if shown.groupOtherRules === null && names}
				<p class="note" data-group="unknown">
					{m['settings.firewallStatusGroupUnknown']({ group: names.group })}
				</p>
			{/if}
		{:else if checking}
			<p class="note">{m['settings.firewallStatusChecking']()}</p>
		{/if}
		{#if problem === 'unavailable'}
			<p class="error">{m['settings.firewallStatusUnavailable']()}</p>
		{:else if problem === 'changed'}
			<p class="error">{m['settings.firewallStatusChanged']()}</p>
		{/if}
	</div>

	<button
		type="button"
		class="banto-btn banto-btn--secondary firewall-copy"
		onclick={() => check()}
		disabled={checking || applying || changing !== null}
	>
		{m['settings.firewallStatusRecheck']()}
	</button>

	{#if actions.length > 0 || changing !== null || changeView !== null || changeProblem !== null}
		<div class="firewall-change">
			<h4>{m['settings.firewallChangeHeading']()}</h4>
			<p class="note">{m['settings.firewallChangeDesc']()}</p>
			{#each firewallChangeManualHints(actions) as hint (hint)}
				<p class="note" data-change-manual-hint={hint}>{m[hint]()}</p>
			{/each}
			{#if actions.length > 0}
				<div class="firewall-change-actions">
					{#each actions as operation (operation)}
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							data-change-operation={operation}
							onclick={() => confirm(operation)}
							disabled={changing !== null || applying}
						>
							{operation === 'allow'
								? m['settings.firewallChangeAllow']()
								: m['settings.firewallChangeRemove']()}
						</button>
					{/each}
				</div>
			{/if}
			<div role="status" aria-live="polite">
				{#if changing !== null}
					<p class="note" data-change="waiting">{m['settings.firewallChangeWaiting']()}</p>
				{:else if changeProblem === 'denied'}
					<p class="error" data-change="denied">{m['settings.firewallChangeDenied']()}</p>
				{:else if changeProblem === 'unavailable'}
					<p class="error" data-change="unavailable">
						{m['settings.firewallChangeUnavailable']()}
					</p>
				{:else if changeView !== null}
					<div
						class="firewall-change-result"
						data-change="result"
						data-outcome={changeOutcome}
						data-tone={changeView.tone}
					>
						{#if changeView.stale}
							<p class="error" data-change="stale">{m['settings.firewallChangeStale']()}</p>
						{/if}
						<p
							class:error={changeView.tone === 'error'}
							class:firewall-change-success={changeView.tone === 'success'}
						>
							{m[changeView.message]()}
						</p>
						{#if changeView.refusal !== null}
							<p data-change="refusal">
								{m['settings.firewallChangeRefusal']({ reason: m[changeView.refusal]() })}
							</p>
						{/if}
						{#if changeView.exitCode !== null}
							<p class="note">
								{m['settings.firewallChangeExitCode']({ code: changeView.exitCode })}
							</p>
						{/if}
						{#if changeView.osError !== null}
							<p class="note">
								{m['settings.firewallChangeOsError']({ code: changeView.osError })}
							</p>
						{/if}
						{#if changeView.noPrompt}
							<p class="note">{m['settings.firewallChangeNoPrompt']()}</p>
						{/if}
						{#if changeView.manual}
							<p class="note" data-change="manual">{m['settings.firewallChangeManual']()}</p>
						{/if}
						{#if changeView.manualRemove}
							<p class="note" data-change="manual-remove">
								{m['settings.firewallChangeManualRemove']()}
							</p>
						{/if}
						{#if changeView.reach}
							<p class="note" data-change="reach">{m['settings.firewallChangeReach']()}</p>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<p class="note">{m['settings.firewallStatusReachNote']()}</p>
</div>

<FirewallChangeDialog
	operation={confirming?.operation ?? null}
	executablePath={confirming?.status.expected.executablePath ?? ''}
	ruleName={names?.programName ?? ''}
	onconfirm={() => void change()}
	oncancel={() => (confirming = null)}
/>
