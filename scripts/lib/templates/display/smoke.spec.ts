/**
 * display プリセットの e2e スモーク（`scripts/scaffold.mjs --preset display` が
 * `e2e/tests/smoke.spec.ts` を丸ごとこれに差し替える。
 * docs/design/display-preset-plan.md §3.2）。
 *
 * テンプレート同梱のスモーク（items の CRUD / CSV / 添付 / ユーザー管理…）は
 * display では画面ごと存在しないので、残るのは **表示専用アプリの成立条件**
 * ひとつだけ:
 *
 *   「まっさらな DB で起動した `banto-serve` に、未ログインのブラウザが `/` を
 *     開くと、ログイン画面を挟まずに `/monitor` が出る」
 *
 * これが通るのは、初回起動シード（`admin-template-core` の
 * `FIRST_BOOT_SETTINGS`）が `server.viewer_public = true` を書き込み、
 * `(app)/+layout.ts` のガードが合成 `viewer` セッション（`{id:"public",
 * role:"viewer"}`、Issue #189 / ADR-0012）を発行するから。ヘッダは
 * ユーザーメニューではなく「ログイン」ボタンを出す。
 *
 * `waitForTimeout`/`sleep` は使わない（すべて locator の自動リトライ）。
 */
import { expect, test } from '@playwright/test';

test('未ログインの `/` が /monitor に着き、合成 viewer として表示される', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveURL(/\/monitor$/);
	await expect(page.getByRole('heading', { name: 'モニター' })).toBeVisible();
	// 合成セッション: ユーザーメニューではなく「ログイン」が出る（Header.svelte）。
	await expect(page.getByRole('banner').getByRole('button', { name: 'ログイン' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
});
