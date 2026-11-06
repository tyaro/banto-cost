/**
 * Desktop-only settings drafts under a stubbed Tauri IPC (issue #214, owner
 * review on PR #232). サーバ・接続 / セキュリティ only render their drafts
 * inside the Tauri webview, which the LAN/REST smoke suite cannot reach.
 * Here `window.__TAURI_INTERNALS__` is replaced before the app loads, and the
 * page is opened on a Tauri asset origin (`http://tauri.localhost`, Issue
 * #396: `isTauri()` also checks the origin, so internals on
 * `http://127.0.0.1:<port>` boot in server mode). The static build served by
 * banto-serve is proxied to that origin with `page.route`, so the app boots in
 * Tauri mode and every `invoke()` lands in the table below (the backend
 * itself is not used; production code has no test-only switch).
 *
 * What it pins down:
 * - Until the saved values load, the drafts cannot be edited (an edit then
 *   would have nothing to compare against, so it could never be detected
 *   as unsaved). A slow load and a failed load both keep them disabled; a
 *   failed one offers 再読み込み.
 * - Once loaded, an edit is protected: switching category asks, and so does
 *   closing the desktop window (close-requested is only watched while
 *   something is unsaved).
 * - The firewall information (Issue #219) shows the LIVE listener's port and
 *   an escaped executable path, refuses to copy once the listener changed,
 *   and says "not needed" for a loopback-only listener. The Windows Firewall
 *   status (PR-B) shows each rule's state, and drops a result for a
 *   listener the screen no longer shows.
 * - The connection check from another device (PR-C3) issues a URL + QR for
 *   a live LAN host and turns into "confirmed" when the 2 s re-read finds
 *   a record (not Windows-only).
 * - The stage-2 firewall change (ADR-0021 E3) opens a confirmation with
 *   decision 1's two sentences, sends the target it showed, disables itself
 *   while "UAC" waits, words each outcome (done never as "reachable") and
 *   shows the re-read that came with the result.
 *
 * Runs in its own page/context - independent of smoke.spec.ts's shared state.
 */
import { expect, test, type Page } from '@playwright/test';

const LEAVE_PROMPT = '保存していない変更があります。変更を破棄してこの画面から移動しますか？';
const CLOSE_PROMPT = '保存していない変更があります。変更を破棄してウィンドウを閉じますか？';

import { installTauriStub, serveOnTauriOrigin, tauriUrl } from './tauri-settings-fixture';

/** Set a knob on the stub. */
async function mock(page: Page, patch: Record<string, unknown>): Promise<void> {
	await page.evaluate((values) => {
		Object.assign((window as unknown as { __bantoMock: object }).__bantoMock, values);
	}, patch);
}

/** Whether a close-requested listener is currently registered (and not removed). */
async function closeListenerActive(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const m = (
			window as unknown as {
				__bantoMock: {
					listens: { event: string; eventId: number }[];
					unlistens: number[];
				};
			}
		).__bantoMock;
		return m.listens.some(
			(l) => l.event === 'tauri://close-requested' && !m.unlistens.includes(l.eventId)
		);
	});
}

/** Fire the OS "close window" request at every live close-requested listener. */
async function requestWindowClose(page: Page): Promise<void> {
	await page.evaluate(() => {
		const m = (
			window as unknown as {
				__bantoMock: {
					listens: { event: string; handler: number; eventId: number }[];
					unlistens: number[];
					callbacks: Map<number, (payload: unknown) => void>;
				};
			}
		).__bantoMock;
		for (const l of m.listens) {
			if (l.event !== 'tauri://close-requested' || m.unlistens.includes(l.eventId)) continue;
			m.callbacks.get(l.handler)?.({ event: l.event, id: l.eventId, payload: null });
		}
	});
}

async function destroyedCount(page: Page): Promise<number> {
	return page.evaluate(
		() => (window as unknown as { __bantoMock: { destroyed: number } }).__bantoMock.destroyed
	);
}

test.describe('Tauri settings drafts (stubbed IPC)', () => {
	test('サーバ・接続: not editable until the saved status loads; edits are then protected', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));
		const port = page.getByLabel('ポート番号');
		const save = page.getByRole('button', { name: '保存して適用' });
		const unsaved = page.getByText('未保存の変更があります');
		const categoryNav = page.getByRole('navigation', { name: '設定カテゴリ' });

		// Slow first load: nothing editable yet.
		await expect(port).toBeVisible();
		await expect(port).toBeDisabled();
		await expect(save).toBeDisabled();

		// It then fails: still not editable, with a retry.
		await mock(page, { serverStatusFails: true });
		await page.evaluate(() =>
			(
				window as unknown as { __bantoMock: { releaseServerStatus: () => void } }
			).__bantoMock.releaseServerStatus()
		);
		await expect(page.getByText('保存済みの設定を読み込めなかったため')).toBeVisible();
		await expect(port).toBeDisabled();
		await expect(save).toBeDisabled();
		await expect(unsaved).toHaveCount(0);

		// Retry succeeds: the saved values arrive and become editable.
		await mock(page, { serverStatusFails: false, serverStatusGate: null });
		await page.getByRole('button', { name: '再読み込み' }).click();
		await expect(port).toBeEnabled();
		await expect(port).toHaveValue('8721');
		await expect(save).toBeEnabled();

		// An edit is now unsaved: switching category asks, "stay" keeps it.
		await port.fill('9000');
		await expect(unsaved).toBeVisible();
		const messages: string[] = [];
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.dismiss();
		});
		await categoryNav.getByRole('link', { name: '外観・言語' }).click();
		await expect.poll(() => messages).toEqual([LEAVE_PROMPT]);
		await expect(page).toHaveURL(/\/settings\/connectivity$/);
		await expect(port).toHaveValue('9000');

		// Closing the desktop window asks too: "stay" keeps the window...
		await expect.poll(() => closeListenerActive(page)).toBe(true);
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.dismiss();
		});
		await requestWindowClose(page);
		await expect.poll(() => messages).toEqual([LEAVE_PROMPT, CLOSE_PROMPT]);
		expect(await destroyedCount(page)).toBe(0);

		// ...and "leave" closes it (the JS side destroys the window).
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.accept();
		});
		await requestWindowClose(page);
		await expect.poll(() => destroyedCount(page)).toBe(1);

		// Discarding makes it clean again: no more close-requested listener.
		await page.getByRole('button', { name: '変更を取り消す' }).click();
		await expect(port).toHaveValue('8721');
		await expect(unsaved).toHaveCount(0);
		await expect.poll(() => closeListenerActive(page)).toBe(false);
	});

	// Owner review of #266 P1 (Issue #260, S-94): turning login-not-required
	// mode on from the settings screen re-binds the Rust session to the
	// synthetic local one (`seq` + 1, not reported to the provider). The save's
	// `refreshAll()` re-runs the guard; its first `auth_resolve` answer is
	// about a `seq` the provider had not observed and is discarded, the
	// provider catches up (S-84), the next answer confirms `kind: 'local'`, and
	// `sessionStore.authDisabled` follows it: the user menu (logout) goes.
	test('セキュリティ: enabling login-not-required mode switches the session to the local one (S-94)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/security'));
		const toggle = page.getByRole('switch', { name: 'ログイン不要モードを有効にする' });
		const save = page.getByRole('button', { name: '保存して適用' });
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(toggle).toBeEnabled();

		await toggle.check();
		page.once('dialog', (dialog) => void dialog.accept()); // authDisableConfirm
		await save.click();

		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		const resolves = await page.evaluate(
			() =>
				(window as unknown as { __bantoMock: { resolves: { checked: number; kind: string }[] } })
					.__bantoMock.resolves
		);
		// The answers after the apply are about seq 2; the last one confirmed `local`.
		const after = resolves.filter((answer) => answer.checked === 2);
		expect(after.length).toBeGreaterThanOrEqual(2); // one discarded, one applied (S-84)
		expect(after.at(-1)?.kind).toBe('local');

		// S-99: turning the mode off again ends the local session at once (seq 3);
		// the save's re-run of the guard catches up and confirms `none` -> /login.
		await expect(toggle).toBeChecked();
		await toggle.uncheck();
		await save.click();
		await expect(page).toHaveURL(/\/login$/);
		const last = await page.evaluate(() =>
			(
				window as unknown as { __bantoMock: { resolves: { checked: number; kind: string }[] } }
			).__bantoMock.resolves.at(-1)
		);
		expect(last).toEqual({ checked: 3, kind: 'none' });
	});

	test('セキュリティ: not editable while the saved auth settings failed to load', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await serveOnTauriOrigin(page, baseURL);
		// Fail from the very first load (the knob must be set before the app boots).
		await page.addInitScript(() => {
			(
				window as unknown as { __bantoMock: { authConfigFails: boolean } }
			).__bantoMock.authConfigFails = true;
		});
		await page.goto(tauriUrl('/settings/security'));
		const toggle = page.getByRole('switch', { name: 'ログイン不要モードを有効にする' });
		const save = page.getByRole('button', { name: '保存して適用' });

		await expect(page.getByText('保存済みの設定を読み込めなかったため')).toBeVisible();
		await expect(toggle).toBeDisabled();
		await expect(save).toBeDisabled();

		await mock(page, { authConfigFails: false });
		await page.getByRole('button', { name: '再読み込み' }).click();
		await expect(toggle).toBeEnabled();
		await expect(save).toBeEnabled();

		await toggle.check();
		await expect(page.getByText('未保存の変更があります')).toBeVisible();
		const messages: string[] = [];
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.dismiss();
		});
		await page
			.getByRole('navigation', { name: '設定カテゴリ' })
			.getByRole('link', { name: '外観・言語' })
			.click();
		await expect.poll(() => messages).toEqual([LEAVE_PROMPT]);
		await expect(page).toHaveURL(/\/settings\/security$/);
		await expect(toggle).toBeChecked();
	});

	test('サーバ・接続: firewall information follows the live listener (Issue #219)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		// Runs after the stub's own init script: a running Windows host whose
		// SAVED port (9000) differs from the live one (8721).
		await page.addInitScript(() => {
			const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
			m.serverStatusGate = null;
			m.appIdentifier = 'dev.banto.admin';
			m.serverStatusPatch = {
				enabled: true,
				running: true,
				bind: '0.0.0.0',
				port: 9000,
				live: { bind: '0.0.0.0', port: 8721 },
				generation: 1,
				executablePath: "C:\\Program Files\\O'Brien\\banto-admin.exe",
				platform: 'windows',
				uiEmbedded: true
			};
			m.firewallRuleStatus = {
				generation: 1,
				expected: { executablePath: "C:\\Program Files\\O'Brien\\banto-admin.exe", port: 8721 },
				program: {
					state: 'present',
					rule: {
						enabled: 'True',
						direction: 'Inbound',
						action: 'Block',
						protocol: 'TCP',
						profile: 'Private',
						program: "C:\\Program Files\\O'Brien\\banto-admin.exe",
						localPorts: ['Any'],
						remoteAddresses: ['LocalSubnet']
					},
					// A Group Policy rule of the same name is in effect; the local one says Allow.
					origin: {
						kind: 'groupPolicy',
						sourceType: 'GroupPolicy',
						source: 'contoso.local\\Banto'
					},
					enforcement: { state: 'enforced' },
					local: {
						state: 'differs',
						rule: {
							enabled: 'True',
							direction: 'Inbound',
							action: 'Allow',
							protocol: 'TCP',
							profile: 'Private',
							program: "C:\\Program Files\\O'Brien\\banto-admin.exe",
							localPorts: ['Any'],
							remoteAddresses: ['LocalSubnet']
						}
					},
					mismatches: ['action'],
					unchecked: []
				},
				port: { state: 'missing' },
				groupOtherRules: 0
			};
		});
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));

		await expect(
			page.getByRole('heading', { name: 'ファイアウォールの許可に必要な情報' })
		).toBeVisible();
		await expect(
			page.getByText("C:\\Program Files\\O'Brien\\banto-admin.exe", { exact: true })
		).toBeVisible();
		// The commands use the live port and the escaped path, never the saved port.
		const commands = page.locator('.firewall-command pre');
		await expect(commands).toHaveCount(2);
		await expect(commands.nth(0)).toContainText(
			"-Program 'C:\\Program Files\\O''Brien\\banto-admin.exe'"
		);
		await expect(commands.nth(1)).toContainText('-LocalPort 8721 ');
		await expect(page.locator('.firewall-info')).not.toContainText('9000');
		// The Windows Firewall status: a central policy's Block is in effect for
		// the program rule (the local Allow does not apply), no port rule.
		const ruleStatus = page.locator('.firewall-status');
		await expect(
			page.getByRole('heading', { name: 'Windows ファイアウォールの状態' })
		).toBeVisible();
		const differs = ruleStatus.locator('[data-state="differs"]');
		await expect(differs).toContainText('dev.banto.admin.lan.tcp.program');
		await expect(differs).toContainText('操作:');
		await expect(differs).toContainText('Block');
		await expect(differs.locator('[data-origin="policy"]')).toContainText(
			'集中管理のポリシー（グループポリシー）のルールです（出どころ: contoso.local\\Banto）'
		);
		await expect(differs.locator('[data-enforcement="enforced"]')).toContainText(
			'適用されています（EnforcementStatus: Full）'
		);
		await expect(differs.locator('[data-local="differs"]')).toBeVisible();
		await expect(differs).toContainText('Allow');
		await expect(ruleStatus.locator('[data-state="missing"]')).toContainText('ルール無し');
		await expect(ruleStatus).toContainText(
			'ルールがあることと、LAN の端末から接続できることは同じではありません。'
		);
		// The listener changed behind the screen: copying refuses and shows the new values.
		await mock(page, {
			serverStatusPatch: {
				enabled: true,
				running: true,
				bind: '0.0.0.0',
				port: 8722,
				live: { bind: '0.0.0.0', port: 8722 },
				generation: 2,
				executablePath: "C:\\Program Files\\O'Brien\\banto-admin.exe",
				platform: 'windows',
				uiEmbedded: true
			}
		});
		await page.getByRole('button', { name: 'ポート単位の許可をコピー' }).click();
		await expect(
			page.getByText('待ち受けの状態が変わったため、コピーしませんでした。')
		).toBeVisible();
		await expect(commands.nth(1)).toContainText('-LocalPort 8722 ');
		// The firewall status still answers for generation 1: not shown for 8722.
		await expect(ruleStatus.locator('[data-state]')).toHaveCount(0);
		await expect(
			page.getByText('確認の途中でサーバーの状態が変わりました。もう一度確認してください。')
		).toBeVisible();

		// Loopback only: no rule needed, no commands.
		await mock(page, {
			serverStatusPatch: {
				enabled: true,
				running: true,
				bind: '127.0.0.1',
				port: 8722,
				live: { bind: '127.0.0.1', port: 8722 },
				generation: 3,
				platform: 'windows',
				uiEmbedded: true
			}
		});
		await page.getByRole('button', { name: 'ポート単位の許可をコピー' }).click();
		await expect(
			page.getByText('このPCのみで待ち受けているため、ファイアウォールの設定は不要です。')
		).toBeVisible();
		await expect(commands).toHaveCount(0);
	});

	test('サーバ・接続: connection check from another device - issue, then confirmed (Issue #219 PR-C3)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		// A running Linux host (the block is not Windows-only), nothing issued yet.
		await page.addInitScript(() => {
			const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
			m.serverStatusGate = null;
			m.serverStatusPatch = {
				enabled: true,
				running: true,
				bind: '0.0.0.0',
				port: 8721,
				live: { bind: '0.0.0.0', port: 8721 },
				urls: ['http://127.0.0.1:8721', 'http://192.168.1.20:8721'],
				generation: 1,
				platform: 'linux',
				uiEmbedded: true
			};
			m.reachCheckStatus = { generation: 1, lastIssue: null, selfAccessAt: null, records: [] };
			m.reachCheckIssue = {
				status: 'issued',
				generation: 1,
				issueId: 1,
				url: 'http://192.168.1.20:8721/reach#t=0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f',
				qrSvg:
					'<svg xmlns="http://www.w3.org/2000/svg" data-reach-qr="1" width="10" height="10"></svg>',
				expiresInMs: 300000
			};
			m.reachStatusAfterIssue = {
				generation: 1,
				lastIssue: {
					issueId: 1,
					host: '192.168.1.20',
					port: 8721,
					expiresAt: Date.now() + 300000,
					outcome: 'pending',
					expiresInMs: 300000
				},
				selfAccessAt: null,
				records: []
			};
		});
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));

		const block = page.locator('.reach-check');
		await expect(page.getByRole('heading', { name: '別の端末からの接続確認' })).toBeVisible();
		await expect(block).toContainText('別の端末からの接続はまだ確認していません。');
		// The firewall blocks are Windows-only; this one is not.
		await expect(page.locator('.firewall-info')).toHaveCount(0);

		await block.getByRole('button', { name: '確認用の URL を発行' }).click();
		await expect(block.locator('[data-reach-state="pending"]')).toBeVisible();
		await expect(block).toContainText(
			'http://192.168.1.20:8721/reach#t=0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f'
		);
		await expect(block.locator('svg[data-reach-qr]')).toHaveCount(1);
		await expect(block).toContainText('有効期限まで残り');
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __bantoMock: { reachIssueHosts: string[] } }).__bantoMock
						.reachIssueHosts
			)
		).toEqual(['192.168.1.20']);

		// Another device opened it: the 2 s re-read picks it up.
		const at = Date.now();
		await mock(page, {
			reachCheckStatus: {
				generation: 1,
				lastIssue: {
					issueId: 1,
					host: '192.168.1.20',
					port: 8721,
					expiresAt: at + 300000,
					outcome: 'recorded',
					expiresInMs: 0
				},
				selfAccessAt: null,
				records: [{ issueId: 1, at, peerIp: '192.168.1.31', host: '192.168.1.20', port: 8721 }]
			}
		});
		const verified = block.locator('[data-reach-state="verified"]');
		await expect(verified).toBeVisible({ timeout: 10_000 });
		await expect(verified).toContainText('別の端末から到達を確認しました。');
		await expect(verified).toContainText('192.168.1.31');
		await expect(verified).toContainText('http://192.168.1.20:8721');
		await expect(verified).toContainText('この時点に、この端末から届いたことの確認です。');
		// The QR of the used URL is gone with the pending state.
		await expect(block.locator('svg[data-reach-qr]')).toHaveCount(0);
	});

	test('サーバ・接続: allow through the elevated helper - confirm, wait, result and re-read (Issue #219 stage 2)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await page.addInitScript(windowsHostWithoutRule);
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));

		const panel = page.locator('.firewall-status');
		await expect(panel.locator('[data-state="missing"]').first()).toBeVisible();
		const allow = panel.getByRole('button', { name: 'ファイアウォールで許可する…' });
		await expect(allow).toBeVisible();
		await expect(panel.getByRole('button', { name: '許可を外す…' })).toHaveCount(0);
		// The by-hand way follows the offered operation (Codex review on PR #475).
		const allowHint = panel.locator('[data-change-manual-hint="settings.firewallChangeDescAllow"]');
		const removeHint = panel.locator(
			'[data-change-manual-hint="settings.firewallChangeDescRemove"]'
		);
		await expect(allowHint).toContainText('上のコマンドを管理者の PowerShell で実行');
		await expect(removeHint).toHaveCount(0);

		// The confirmation screen: decision 1's two sentences, the target, the UAC note.
		await allow.click();
		const dialog = page.getByRole('dialog', { name: 'Windows ファイアウォールで許可する' });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('[data-confirm="ports"]')).toHaveText(
			'この実行ファイルが待ち受ける全ての TCP ポートを、プライベート ネットワークから許可します。'
		);
		await expect(dialog.locator('[data-confirm="subnet"]')).toHaveText(
			'接続元の範囲「ローカル サブネット」は、PC に複数のネットワーク アダプターや VPN があると、そのそれぞれのサブネットを含むことがあります。'
		);
		await expect(dialog).toContainText(FW_EXE);
		await expect(dialog).toContainText('dev.banto.admin.lan.tcp.program');
		await expect(dialog).toContainText('Windows の確認（ユーザー アカウント制御）が表示されます');
		// Cancelling starts nothing.
		await dialog.getByRole('button', { name: 'キャンセル' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await firewallChangeCalls(page)).toEqual([]);

		// Approve: the helper "waits for UAC" until released.
		await page.evaluate((status) => {
			const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
			m.firewallChangeGate = new Promise<void>((resolve) => {
				m.releaseFirewallChange = resolve;
			});
			m.firewallChange = {
				operation: 'allow',
				outcome: 'done',
				exitCode: 0,
				refusal: null,
				osError: null,
				stale: false,
				status
			};
		}, firewallStatusWithRule());
		await allow.click();
		await dialog.getByRole('button', { name: '許可する', exact: true }).click();
		await expect(panel.locator('[data-change="waiting"]')).toContainText(
			'Windows の確認（ユーザー アカウント制御）の応答を待っています。'
		);
		await expect(allow).toBeDisabled();
		await expect(panel.getByRole('button', { name: '再確認' })).toBeDisabled();
		// The target is what the confirmation showed (decision 13).
		expect(await firewallChangeCalls(page)).toEqual([
			{ operation: 'allow', target: { executablePath: FW_EXE, generation: 1 } }
		]);

		await page.evaluate(() =>
			(
				window as unknown as { __bantoMock: { releaseFirewallChange: () => void } }
			).__bantoMock.releaseFirewallChange()
		);
		const outcome = panel.locator('[data-change="result"]');
		await expect(outcome).toHaveAttribute('data-outcome', 'done');
		await expect(outcome).toContainText('許可のルールを作りました。');
		// Exit 0 is "done", never "reachable": it points to the reach check.
		await expect(outcome.locator('[data-change="reach"]')).toContainText(
			'別の端末からの接続確認」で確かめてください。'
		);
		// The re-read that came with the result replaced the status.
		await expect(panel.locator('[data-state="matches"]')).toContainText(
			'dev.banto.admin.lan.tcp.program'
		);
		await expect(panel.getByRole('button', { name: '許可を外す…' })).toBeEnabled();
		await expect(allow).toHaveCount(0);
		// Only "remove" is offered now: its by-hand way, never the allow command.
		await expect(removeHint).toContainText("Remove-NetFirewallRule -Name '<ルール名>'");
		await expect(allowHint).toHaveCount(0);
		await expect(panel.locator('.firewall-change')).not.toContainText('上のコマンド');
	});

	test('サーバ・接続: firewall change results - cancelled, busy, precondition, target changed (Issue #219 stage 2)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await page.addInitScript(windowsHostWithoutRule);
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));

		const panel = page.locator('.firewall-status');
		const allow = panel.getByRole('button', { name: 'ファイアウォールで許可する…' });
		const outcome = panel.locator('[data-change="result"]');

		async function run(answer: Record<string, unknown>): Promise<void> {
			await page.evaluate(
				(a) => {
					const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
					m.firewallChange = { ...a, status: m.firewallRuleStatus };
				},
				{
					operation: 'allow',
					exitCode: null,
					refusal: null,
					osError: null,
					stale: false,
					...answer
				}
			);
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await allow.click();
			await page
				.getByRole('dialog', { name: 'Windows ファイアウォールで許可する' })
				.getByRole('button', { name: '許可する', exact: true })
				.click();
			await expect(outcome).toHaveAttribute('data-outcome', String(answer.outcome));
		}

		await run({ outcome: 'cancelled' });
		await expect(outcome).toContainText(
			'Windows の確認（ユーザー アカウント制御）で取り消されました。何も変えていません。'
		);
		await expect(outcome).not.toContainText('失敗');

		await run({ outcome: 'busy' });
		await expect(outcome).toContainText(
			'別のファイアウォールの変更が実行中のため、何もしていません。'
		);

		await run({ outcome: 'precondition', refusal: 'notUnderProgramFiles' });
		await expect(outcome).toContainText('この配置では、ここから許可を変更できません。');
		await expect(outcome.locator('[data-change="refusal"]')).toContainText(
			'Program Files の下にインストールされていません'
		);
		await expect(outcome).toContainText(
			'Windows の確認（ユーザー アカウント制御）は出していません。'
		);
		await expect(outcome.locator('[data-change="manual"]')).toBeVisible();

		await run({ outcome: 'targetChanged' });
		await expect(outcome).toContainText(
			'確認の画面を出した後にサーバーの状態が変わったため、何もしていません。'
		);

		// A result whose target changed while the helper ran is marked stale.
		await run({ outcome: 'done', exitCode: 0, stale: true });
		await expect(outcome.locator('[data-change="stale"]')).toContainText(
			'変更の途中でサーバーの状態が変わりました。'
		);

		expect((await firewallChangeCalls(page)).length).toBe(5);
	});
});

const FW_EXE = 'C:\\Program Files\\Banto\\banto-admin.exe';

/** A per-executable rule as the helper creates it (enforced). */
function firewallStatusWithRule(): unknown {
	return {
		generation: 1,
		expected: { executablePath: FW_EXE, port: 8721 },
		program: {
			state: 'present',
			rule: {
				enabled: 'True',
				direction: 'Inbound',
				action: 'Allow',
				protocol: 'TCP',
				profile: 'Private',
				program: FW_EXE,
				localPorts: ['Any'],
				remoteAddresses: ['LocalSubnet']
			},
			origin: { kind: 'local', sourceType: 'Local', source: 'PersistentStore' },
			enforcement: { state: 'enforced' },
			local: { state: 'same' },
			mismatches: [],
			unchecked: []
		},
		port: { state: 'missing' },
		groupOtherRules: 0
	};
}

/** Init script: a running Windows host serving the LAN, with no firewall rule yet. */
function windowsHostWithoutRule(): void {
	const exe = 'C:\\Program Files\\Banto\\banto-admin.exe';
	const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
	m.serverStatusGate = null;
	m.appIdentifier = 'dev.banto.admin';
	m.serverStatusPatch = {
		enabled: true,
		running: true,
		bind: '0.0.0.0',
		port: 8721,
		live: { bind: '0.0.0.0', port: 8721 },
		generation: 1,
		executablePath: exe,
		platform: 'windows',
		uiEmbedded: true
	};
	m.firewallRuleStatus = {
		generation: 1,
		expected: { executablePath: exe, port: 8721 },
		program: { state: 'missing' },
		port: { state: 'missing' },
		groupOtherRules: 0
	};
}

async function firewallChangeCalls(page: Page): Promise<unknown[]> {
	return page.evaluate(
		() =>
			(window as unknown as { __bantoMock: { firewallChangeCalls: unknown[] } }).__bantoMock
				.firewallChangeCalls
	);
}
