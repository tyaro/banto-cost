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
 *   2. the screen allowlist (`NavItem.publicViewer`) holds - banto-cost
 *      lists only the dashboard (the template's `/items` demo was removed);
 *      `/customers`, `/users` and `/settings` bounce back to it;
 *   2a. a public screen opened while the server is unreachable shows the
 *      startup splash with 再接続, then enters as the viewer (Issue #321);
 *   3. the write surface stays closed - `POST /api/customers` with the public
 *      token is 403;
 *   4. "ログイン" leads to the normal login/setup screen and a real account
 *      gets the normal UI back; logging out again offers "閲覧のみで続ける",
 *      which re-enters the synthetic session;
 *   5. a session that ends moves to the synthetic viewer on the public
 *      screen, without the account's menu or admin entries (Issue #215/#255).
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

	test('2. only the dashboard is public; the admin nav and other screens are hidden', async () => {
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		// Allowlist: no business or admin nav, and settings is not public either.
		await expect(page.getByRole('link', { name: '顧客', exact: true })).toHaveCount(0);
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
			await monitor.goto('/dashboard');
			await expect(monitor.getByRole('status')).toHaveText('起動中…');
			// 3 probes 1.5 s apart (STARTUP_AUTO_RETRIES) before the screen appears.
			await expect(monitor.getByRole('alert')).toContainText('サーバーに接続できません', {
				timeout: 15_000
			});
			await expect(monitor).toHaveURL(/\/dashboard$/);
			await monitor.unroute('**/api/**', serverDown);

			await monitor.getByRole('alert').getByRole('button', { name: '再接続' }).click();
			await expect(monitor).toHaveURL(/\/dashboard$/);
			await expect(monitor.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
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
			await expect(nav.getByRole('link')).toHaveCount(1);
			await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
			await expect(monitor.getByRole('navigation', { name: '管理ナビゲーション' })).toHaveCount(0);
			await expect(monitor.getByRole('link', { name: '設定' })).toHaveCount(0);
		} finally {
			await monitor.close();
		}
	});

	test('3. a non-public screen bounces back to the first public one', async () => {
		await page.goto('/customers');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/users');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('4. the public token cannot write: POST /api/customers is 403', async () => {
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

		const write = await page.request.post('/api/customers', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` },
			data: { name: 'should-not-exist', active: true }
		});
		expect(write.status()).toBe(403);
	});

	test('5. "ログイン" reaches the setup screen; a real account restores the normal UI', async () => {
		// Wait for the viewer's change stream to open before signing in, so the
		// check below sees it being replaced (not merely opened after login).
		const viewerStream = page.waitForRequest(
			(request) =>
				new URL(request.url()).pathname === '/api/events' &&
				request.headers().authorization !== undefined
		);
		await page.goto('/dashboard');
		const viewerAuth = (await viewerStream).headers().authorization;
		const viewerToken = await page.evaluate(() => sessionStorage.getItem('banto.auth.token'));
		expect(viewerToken).not.toBeNull();
		expect(viewerAuth).toBe(`Bearer ${viewerToken}`);
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);

		// Zero users -> setup form (same as smoke scenario 1).
		await page.getByLabel('表示名').fill(ADMIN_DISPLAY_NAME);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
		await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
		// The change stream opened with the viewer's grant token must be
		// re-opened with the new login's token at once, not when the old
		// stream happens to end (a viewer stream never ends on its own).
		const loginStream = page.waitForRequest((request) => {
			if (new URL(request.url()).pathname !== '/api/events') return false;
			const auth = request.headers().authorization;
			return auth !== undefined && auth !== `Bearer ${viewerToken}`;
		});
		await page.getByRole('button', { name: 'アカウントを作成' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(loginButton(page)).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
		const loginToken = await page.evaluate(() => sessionStorage.getItem('banto.auth.token'));
		expect((await loginStream).headers().authorization).toBe(`Bearer ${loginToken}`);
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
	// that ends is replaced by the synthetic viewer session. (The template
	// checked that the items list's search/sort/highlighted row did not carry
	// over; banto-cost's only public screen is the dashboard, so this checks
	// the session swap itself.)
	test('7. a session that ends moves to the viewer on the public screen', async () => {
		test.setTimeout(120_000);
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();

		// End this account's sessions from inside the session itself: a
		// password reset (to the same value) bumps the account's auth epoch
		// (Issue #204). On the next load the guard's identity check gets a 401,
		// so it enters the synthetic viewer session on the public dashboard.
		// (Not the event stream: it was opened by the earlier viewer session
		// and the login does not reopen it, so its token is still valid.)
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
		await page.reload();
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
	});

	// Issue #215/#255 5th review: the guard's identity request for the
	// PREVIOUS session (here the synthetic viewer, re-checked on a client-side
	// navigation) answers only after this tab has logged in as the admin and
	// shown the admin's dashboard. That late answer must not move the session
	// back to the viewer: no "ログイン" button, no lost dashboard (a changed
	// session generation would hide the page), the admin's menu stays.
	test('8. a late identity answer for the previous session does not replace the next login', async () => {
		test.setTimeout(60_000);
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
			// answer is held, so the tab stays on the dashboard. (A client-side
			// move to a non-public screen: the only public one is the dashboard.)
			await page.evaluate(() => {
				const a = document.createElement('a');
				a.href = '/customers';
				document.body.appendChild(a);
				a.click();
				a.remove();
			});
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
