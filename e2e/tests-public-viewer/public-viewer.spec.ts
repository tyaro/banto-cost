/**
 * Viewer-public mode E2E (docs/design/viewer-public-plan.md §3.1-8, Issue #189,
 * ADR-0012). The synthetic viewer session is the `publicViewer` grant
 * (`POST /api/auth/grant/publicViewer`, ADR-0017).
 *
 * Runs against the SECOND `banto-serve` playwright.config.ts starts with
 * `BANTO_VIEWER_PUBLIC=1` (own port, own fresh SQLite DB - see the config's
 * doc comment for why the smoke server cannot double as this one). Like the
 * smoke suite it is one shared page in file order: scenario 1 relies on the
 * DB having ZERO users (the display-only app's setup-skipped shape), later
 * scenarios build on the admin account scenario 4 creates.
 *
 * What it proves, end to end, on the real REST/SSE path:
 *   1. an unauthenticated LAN browser lands on the dashboard as the synthetic
 *      `viewer` (no login screen, header shows "ログイン" instead of the user
 *      menu, role chip says 閲覧者);
 *   2. the screen allowlist (`NavItem.publicViewer`) holds - `/items` is
 *      visible but read-only, `/users` bounces back to the dashboard;
 *   2a. a public screen opened while the server is unreachable shows the
 *      startup splash with 再接続, then enters as the viewer (Issue #321);
 *   3. the write surface stays closed - `POST /api/items` with the public
 *      token is 403;
 *   4. "ログイン" leads to the normal login/setup screen and a real account
 *      gets the normal UI back; logging out again offers "閲覧のみで続ける",
 *      which re-enters the synthetic session;
 *   5. a session that ends while a list is open moves to the synthetic
 *      viewer without carrying its search/sort/highlighted row over
 *      (Issue #215/#255).
 *
 * No `waitForTimeout`/`sleep`: every wait is a locator auto-retry.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { expectCheckOutageKeepsTheSession } from '../tests/session-check-outage';

// #209: a normal account may share the synthetic identity's string ID.
const ADMIN_USERNAME = 'public';
const ADMIN_PASSWORD = 'E2ePvAdminPass1';
const ADMIN_DISPLAY_NAME = 'E2E閲覧公開管理者';

const CLIENT_HEADER = { 'X-Banto-Client': 'banto' };

/** Issue #260 実装-3 (wiring ②): the change-of-user notice (messages/ja.json `session.ownerChanged`). */
const OWNER_CHANGED_NOTICE = '別のユーザーでログインされました';

/** The header's "ログイン" button that replaces the user menu for the synthetic viewer (Header.svelte, plan §3.1-6). */
function loginButton(page: Page) {
	return page.getByRole('banner').getByRole('button', { name: 'ログイン' });
}

test.describe.serial('Banto viewer-public mode', () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage({ reducedMotion: 'reduce' });
	});

	test.afterAll(async () => {
		await page?.close();
	});

	test('1. an unauthenticated visit enters the dashboard as the synthetic viewer', async () => {
		await page.goto('/dashboard');

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		// Synthetic session: role chip 閲覧者, "ログイン" instead of the user menu.
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
	});

	test('2. items is visible read-only and the admin nav is hidden', async () => {
		await page.goto('/items');
		await expect(page).toHaveURL(/\/items$/);
		// viewer role: the grid renders, the create button does not.
		await expect(page.getByRole('grid')).toBeVisible();
		await expect(page.getByRole('button', { name: '新規作成' })).toHaveCount(0);
		// Allowlist: no admin nav, and settings is not public either.
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '設定' })).toHaveCount(0);

		// The Ctrl+K palette follows the same allowlist (navSections()): it lists
		// the public screen but not the ones the route guard would bounce.
		await page.keyboard.press('Control+K');
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		await expect(palette).toBeVisible();
		await expect(palette.getByText('ダッシュボード', { exact: true })).toBeVisible();
		await expect(palette.getByText('ツリービュー', { exact: true })).toHaveCount(0);
		await expect(palette.getByText('設定', { exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(palette).toHaveCount(0);
	});

	// Issue #321: a wall monitor opening its screen while the server is
	// unreachable (power-on order, a restart). The splash offers 再接続 on that
	// URL - never the demo (#286), never a blank page - and once the server is
	// back the reconnect enters the synthetic viewer on the same screen. Own
	// page: no stored token, like the monitor's first visit.
	test('2a. a public screen opened while the server is unreachable offers reconnect, then enters as the viewer', async ({
		browser
	}) => {
		const monitor = await browser.newPage({ reducedMotion: 'reduce' });
		try {
			const serverDown = (route: Route) => route.abort('connectionrefused');
			await monitor.route('**/api/**', serverDown);
			await monitor.goto('/items');
			await expect(monitor.getByRole('status')).toHaveText('起動中…');
			// 3 probes 1.5 s apart (STARTUP_AUTO_RETRIES) before the screen appears.
			await expect(monitor.getByRole('alert')).toContainText('サーバーに接続できません', {
				timeout: 15_000
			});
			await expect(monitor).toHaveURL(/\/items$/);
			await monitor.unroute('**/api/**', serverDown);

			await monitor.getByRole('alert').getByRole('button', { name: '再接続' }).click();
			await expect(monitor).toHaveURL(/\/items$/);
			await expect(monitor.getByRole('grid')).toBeVisible();
			await expect(monitor.getByRole('banner').getByText('閲覧者')).toBeVisible();
			await expect(loginButton(monitor)).toBeVisible();
		} finally {
			await monitor.close();
		}
	});

	// nav-launcher-plan.md §4.9/§7.2: the dock shows the same allowlist as the
	// sidebar. Own page with the dock chosen: the local cache is primed and the
	// stored setting is answered as 'launcher' (a read with nothing stored
	// resets the layout to the sidebar, §3).
	test('2b. with the dock layout, only the allowlisted entries appear in the dock', async ({
		browser
	}) => {
		const monitor = await browser.newPage({ reducedMotion: 'reduce' });
		try {
			await monitor.addInitScript(() => {
				window.localStorage.setItem('banto.navLayout', 'launcher');
			});
			await monitor.route('**/api/ui-settings/shell.navLayout', (route) =>
				route.request().method() === 'GET'
					? route.fulfill({ json: { value: 'launcher' } })
					: route.continue()
			);
			await monitor.goto('/dashboard');
			await expect(monitor.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(monitor.locator('.launcher')).toBeVisible();
			await expect(monitor.locator('aside')).toHaveCount(0);

			const nav = monitor.getByRole('navigation', { name: '主要ナビゲーション' });
			await expect(nav.getByRole('link')).toHaveCount(2);
			await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
			await expect(nav.getByRole('link', { name: '商品' })).toBeVisible();
			await expect(monitor.getByRole('navigation', { name: '管理ナビゲーション' })).toHaveCount(0);
			await expect(monitor.getByRole('link', { name: '設定' })).toHaveCount(0);
		} finally {
			await monitor.close();
		}
	});

	test('3. a non-public screen bounces back to the first public one', async () => {
		await page.goto('/users');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('4. the public token cannot write: POST /api/items is 403', async () => {
		const mint = await page.request.post('/api/auth/grant/publicViewer', {
			headers: CLIENT_HEADER
		});
		expect(mint.ok()).toBe(true);
		const { token } = (await mint.json()) as { success: boolean; token: string };
		expect(token).toBeTruthy();

		const identity = await page.request.get('/api/auth/identity', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` }
		});
		expect(identity.ok()).toBe(true);
		expect(await identity.json()).toMatchObject({
			id: 'public',
			role: 'viewer',
			kind: 'publicViewer'
		});

		const write = await page.request.post('/api/items', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` },
			data: { name: 'should-not-exist', price: 1, stock: 1 }
		});
		expect(write.status()).toBe(403);
	});

	test('5. "ログイン" reaches the setup screen; a real account restores the normal UI', async () => {
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);

		// Zero users -> setup form (same as smoke scenario 1).
		await page.getByLabel('表示名').fill(ADMIN_DISPLAY_NAME);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
		await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'アカウントを作成' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(loginButton(page)).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
		// S-93: leaving the public viewer by signing in is not "another user
		// signed in" - no change-of-user notice (audit of #260 実装-3 P2-1).
		await expect(page.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);

		// Restoring an ordinary "public" account must keep its normal UI
		// while anonymous public viewing is enabled on the same server.
		const restoredIdentity = page.waitForResponse(
			(response) => new URL(response.url()).pathname === '/api/auth/identity'
		);
		await page.reload();
		const identity = await restoredIdentity;
		expect(identity.ok()).toBe(true);
		expect(await identity.json()).toMatchObject({
			id: 'public',
			role: 'admin',
			kind: 'account'
		});
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(loginButton(page)).toHaveCount(0);
		await page.goto('/users');
		await expect(page).toHaveURL(/\/users$/);
		await expect(page.locator('section.create')).toBeVisible();
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/settings$/);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
	});

	// Issue #204 review: with public viewing ON, an auth-check outage (500) used
	// to fall through to enterGrant('publicViewer'), replacing the login token with a
	// viewer one (and wiping a "Remember me" token). It must keep the session.
	test('5a. an auth-check outage keeps the login session instead of switching to the viewer', async () => {
		await expectCheckOutageKeepsTheSession(page, false);

		await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
		await page.getByRole('menuitem', { name: 'ログアウト' }).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByLabel('ログイン状態を保持する（30日間）').check();
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await expectCheckOutageKeepsTheSession(page, true);
	});

	test('6. logging out offers "閲覧のみで続ける", which re-enters the synthetic session', async () => {
		await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
		await page.getByRole('menuitem', { name: 'ログアウト' }).click();
		await expect(page).toHaveURL(/\/login$/);

		await page.getByRole('button', { name: '閲覧のみで続ける' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();

		const restoredIdentity = page.waitForResponse(
			(response) => new URL(response.url()).pathname === '/api/auth/identity'
		);
		await page.reload();
		const identity = await restoredIdentity;
		expect(identity.ok()).toBe(true);
		expect(await identity.json()).toMatchObject({
			id: 'public',
			role: 'viewer',
			kind: 'publicViewer'
		});
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '設定' })).toHaveCount(0);
		await page.goto('/users');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	// Issue #215/#255 4th review (P2 2): with public viewing ON, a session
	// that ends while /items is open is replaced by the synthetic viewer
	// session in place - SvelteKit re-runs the loads but would keep the same
	// page component, whose GridState still held the ended session's search
	// and sort (and its highlighted row), and the viewer's next sort used to
	// save that old search back. The page must be rebuilt for the new
	// session: nothing of the old one on screen, and nothing of it restored
	// after a round trip to another screen.
	test('7. a session that ends on /items moves to the viewer without its search, sort or highlighted row', async () => {
		test.setTimeout(120_000);
		const SEARCH = '茶';
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();

		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		await mainNav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await page.getByRole('button', { name: '商品名の絞り込み' }).click();
		const nameFilter = page.getByRole('dialog', { name: '商品名の絞り込み' });
		await nameFilter.getByPlaceholder('値を入力').fill(SEARCH);
		await nameFilter.getByRole('button', { name: '適用' }).click();
		const priceHeader = page.getByRole('grid').getByRole('columnheader', { name: '価格' });
		await priceHeader.locator('.cell-body').click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		await page
			.getByRole('row')
			.filter({ hasText: SEARCH })
			.first()
			.getByRole('link', { name: '開く' })
			.click();
		await expect(page).toHaveURL(/\/items\/\d+$/);
		// Wait for the detail page itself (it records the opened row when it is
		// created) - the URL changes before it has rendered.
		await expect(page.getByRole('heading', { name: '商品を編集' })).toBeVisible();
		await page.goBack();
		await expect(page).toHaveURL(/\/items$/);
		await expect(page.locator('.items-row-last-opened')).toHaveCount(1);

		// End this account's sessions from inside the session itself: a
		// password reset (to the same value) bumps the account's auth epoch
		// (Issue #204). The stream is closed at the server's next
		// revalidation (15 s), its reconnect gets a 401, check() confirms, and
		// the guard enters the synthetic viewer session - /items is public, so
		// the tab stays on it.
		await page.evaluate(
			async ({ username, password }) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const headers = { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` };
				const list = await fetch('/api/users', { headers });
				if (!list.ok) throw new Error(`list failed: ${list.status}`);
				const body = (await list.json()) as
					{ id: number; username: string }[] | { rows: { id: number; username: string }[] };
				const rows = Array.isArray(body) ? body : body.rows;
				const self = rows.find((row) => row.username === username);
				if (!self) throw new Error('admin account not found');
				const reset = await fetch(`/api/users/${self.id}/reset-password`, {
					method: 'POST',
					headers: { ...headers, 'Content-Type': 'application/json' },
					body: JSON.stringify({ newPassword: password })
				});
				if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
			},
			{ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
		);
		await expect(loginButton(page)).toBeVisible({ timeout: 40_000 });
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
		await expect(page).toHaveURL(/\/items$/);

		const expectNoOldSession = async () => {
			await page.getByRole('button', { name: '商品名の絞り込み' }).click();
			await expect(
				page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
			).toHaveValue('');
			await page.keyboard.press('Escape');
			await expect(page.locator('.items-row-last-opened')).toHaveCount(0);
			const saved = await page.evaluate(() =>
				Object.keys(sessionStorage)
					.filter((key) => key.startsWith('banto.listView.'))
					.map((key) => sessionStorage.getItem(key))
					.join('\n')
			);
			expect(saved, 'the ended session search term is not saved').not.toContain(SEARCH);
		};

		// The page on screen was rebuilt for the viewer session.
		await expect(priceHeader).toHaveAttribute('aria-sort', 'none');
		await expectNoOldSession();

		// One sort as the viewer (the kept page used to save the old search
		// along with it), then a round trip through another screen.
		await priceHeader.locator('.cell-body').click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		await mainNav.getByRole('link', { name: 'ダッシュボード' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await mainNav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);

		// The viewer's own sort is restored; nothing of the ended session is.
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		await expectNoOldSession();
	});

	// Issue #215/#255 5th review: the guard's identity request for the
	// PREVIOUS session (here the synthetic viewer, re-checked on a client-side
	// navigation) answers only after this tab has logged in as the admin and
	// shown the admin's dashboard. That late answer must not move the session
	// back to the viewer: no "ログイン" button, no lost dashboard (a changed
	// session generation would hide the page), the admin's menu stays.
	test('8. a late identity answer for the previous session does not replace the next login', async () => {
		test.setTimeout(60_000);
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		await page.goto('/dashboard');
		await expect(loginButton(page)).toBeVisible();

		let held = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/api/auth/identity', async (route) => {
			if (held > 0) return route.continue();
			held += 1;
			// Sent now, with the viewer's token; delivered after the login.
			const response = await route.fetch();
			await gate;
			await route.fulfill({ response });
		});
		try {
			// A public viewer's guard re-runs on every navigation; its identity
			// answer is held, so the tab stays on the dashboard.
			await mainNav.getByRole('link', { name: '商品' }).click();
			await expect.poll(() => held).toBe(1);
			await loginButton(page).click();
			await expect(page).toHaveURL(/\/login$/);
			await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await page.getByRole('button', { name: 'ログイン', exact: true }).click();
			await expect(page).toHaveURL(/\/dashboard$/);
			const userMenu = page.getByRole('button', { name: 'ユーザーメニューを開く' });
			await expect(userMenu).toBeVisible();
			await expect(page.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0); // S-93

			release();
			// Same bounded exception as smoke scenario 3d: nothing visible
			// signals "the late answer was processed", and a poll would pass on
			// its first read before a wrong write could happen.
			await page.waitForTimeout(500);
			await expect(page).toHaveURL(/\/dashboard$/);
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(userMenu).toBeVisible();
			await expect(loginButton(page)).toHaveCount(0);
		} finally {
			release();
			await page.unrouteAll({ behavior: 'wait' });
		}
	});
});
