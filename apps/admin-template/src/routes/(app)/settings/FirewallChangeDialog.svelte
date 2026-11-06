<script lang="ts">
	/**
	 * ファイアウォールの許可・解除の確認画面（Issue #219 段階 2、ADR-0021 E3）。
	 * FirewallRuleStatusPanel.svelte が、表示している読み取り結果を対象にして開く。
	 *
	 * 許可では、ADR-0021 決定 1 の 2 文（全 TCP ポートをプライベート ネットワーク
	 * から許可する／ローカル サブネットは複数のアダプター・VPN のサブネットを
	 * 含みうる）を必ず出す。対象の実行ファイルとルール名、この後に Windows の
	 * 確認（UAC）が出ることも出す。承認で `onconfirm`、Esc・背景・×・取消で
	 * `oncancel`（何も起動しない）。
	 *
	 * 文言はすべて messages 経由（conventions §13）。
	 */
	import { Modal } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import type { FirewallChangeOperation } from '#lib/banto/serverAdmin.js';

	interface Props {
		/** `null` = closed. */
		operation: FirewallChangeOperation | null;
		executablePath: string;
		ruleName: string;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { operation, executablePath, ruleName, onconfirm, oncancel }: Props = $props();

	const overlayMessages = { overlayClose: () => m['common.close']() };
</script>

<Modal
	open={operation !== null}
	title={operation === 'remove'
		? m['settings.firewallConfirmRemoveTitle']()
		: m['settings.firewallConfirmAllowTitle']()}
	width="36rem"
	messages={overlayMessages}
	onclose={oncancel}
>
	<div class="firewall-confirm" data-operation={operation}>
		{#if operation === 'remove'}
			<p>{m['settings.firewallConfirmRemoveScope']()}</p>
		{:else}
			<p class="scope" data-confirm="ports">{m['settings.firewallConfirmAllowPorts']()}</p>
			<p class="scope" data-confirm="subnet">{m['settings.firewallConfirmAllowSubnet']()}</p>
		{/if}
		<dl>
			<dt>{m['settings.firewallConfirmExecutable']()}</dt>
			<dd><code>{executablePath}</code></dd>
			<dt>{m['settings.firewallConfirmRuleName']()}</dt>
			<dd><code>{ruleName}</code></dd>
		</dl>
		<p class="uac">{m['settings.firewallConfirmUac']()}</p>
		<div class="actions">
			<button type="button" class="banto-btn banto-btn--secondary" onclick={oncancel}>
				{m['common.cancel']()}
			</button>
			<button
				type="button"
				class={operation === 'remove'
					? 'banto-btn banto-btn--danger'
					: 'banto-btn banto-btn--primary'}
				onclick={onconfirm}
			>
				{operation === 'remove'
					? m['settings.firewallConfirmRemoveSubmit']()
					: m['settings.firewallConfirmAllowSubmit']()}
			</button>
		</div>
	</div>
</Modal>

<style>
	.firewall-confirm p {
		margin: 0 0 var(--banto-space-3);
		color: var(--banto-text);
		text-wrap: pretty;
	}

	.firewall-confirm .scope {
		font-weight: 600;
	}

	.firewall-confirm dl {
		margin: 0 0 var(--banto-space-3);
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--banto-space-1) var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
	}

	.firewall-confirm dt {
		color: var(--banto-text-muted);
	}

	.firewall-confirm dd {
		margin: 0;
		min-width: 0;
	}

	.firewall-confirm code {
		overflow-wrap: anywhere;
	}

	.firewall-confirm .uac {
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--banto-space-2);
	}
</style>
