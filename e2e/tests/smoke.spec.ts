/**
 * M18 Phase B smoke E2E (docs/roadmap.md M18, docs/history/improvements.md §4).
 *
 * Runs against a real `banto-serve --features embed-ui` (LAN/REST mode, no
 * mocked DataProvider - see playwright.config.ts's doc comment) with a
 * brand-new SQLite database, so scenario 1 legitimately hits the first-run
 * setup screen. All scenarios share ONE browser page/session and run in
 * file order (`describe.serial` + `workers: 1`, config-wide): later
 * scenarios rely on state earlier ones created (the admin account, the
 * customers, the viewer account, the audit trail, ...), the same way a person
 * clicking through the app once would. This is intentionally NOT a
 * from-scratch-state-per-test suite - keep new scenarios in this ordering
 * discipline rather than trying to make them independent.
 *
 * Deliberately scoped to a smoke pass (one scenario per screen, ~11 tests
 * total, per roadmap M18's non-scope note) - not exhaustive coverage of any
 * one feature (M14 audit log, M16 command palette, M17 backups already
 * have their own focused unit/integration tests elsewhere).
 *
 * banto-cost: the template's `items` demo was removed (2026-11). The CRUD /
 * unsaved-changes / SPA scenarios now run on the 顧客 (customers) screens;
 * the items-only ones (inline grid editing, CSV export/import, the list
 * filter/sort round trip and its last-edited marker) were dropped with it.
 * The cross-client nav badge (scenario 13) runs on customers, which emit
 * `resource_changed` like items did.
 *
 * Flakiness: no explicit `waitForTimeout`/`sleep` in this file except one -
 * every wait is either Playwright's built-in locator auto-retry
 * (`expect(locator)...`) or a real event (`page.waitForEvent('download')`,
 * `page.once('dialog', ...)`). The exception is scenario 13b's "the event
 * stream sends nothing more" check, which can only be observed over a window.
 */
import { expect, test, type Dialog, type Locator, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import { expectCheckOutageKeepsTheSession } from './session-check-outage';

// #209: this ordinary account must not be confused with a synthetic session.
const ADMIN_USERNAME = 'public';
const ADMIN_PASSWORD = 'E2eAdminPass1';
const ADMIN_DISPLAY_NAME = 'E2E管理者';

const VIEWER_USERNAME = 'e2e-viewer';
const VIEWER_PASSWORD = 'E2eViewerPass1';
const VIEWER_DISPLAY_NAME = 'E2E閲覧者';

// Fictional customers (banto-cost CLAUDE.md: no real names). Timestamped so
// the name doubling as the grid-filter needle can never collide with a
// leftover row.
const RUN = Date.now();
const CUSTOMER_A = `E2E見本工業-${RUN}`;
const CUSTOMER_A_RENAMED = `E2E見本工業（改）-${RUN}`;
const CUSTOMER_B = `E2E試作電機-${RUN}`;

/** Call the REST API from the page with the session's own bearer token (same lookup order as admin-core's HTTP auth provider). */
async function api<T = unknown>(
	page: Page,
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	return page.evaluate(
		async ({ method, path, body }) => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const headers: Record<string, string> = {
				'X-Banto-Client': 'banto',
				Authorization: `Bearer ${token}`
			};
			if (body !== undefined) headers['Content-Type'] = 'application/json';
			const res = await fetch(path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
			return res.status === 204 ? null : res.json();
		},
		{ method, path, body }
	) as Promise<T>;
}

/** `YYYY-MM` of this month and next month in the browser's local time (the dashboard's own rule). */
async function thisAndNextMonth(page: Page): Promise<{ current: string; next: string }> {
	return page.evaluate(() => {
		const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		const now = new Date();
		return { current: ym(now), next: ym(new Date(now.getFullYear(), now.getMonth() + 1, 1)) };
	});
}

/** Open a filterable column's header filter and apply a "contains" filter (the default op) with `value`. Mirrors a user clicking the ▾ icon, typing, and clicking 適用 (FilterPopover.svelte). */
async function applyColumnFilter(page: Page, columnHeader: string, value: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label }).click();
	const dialog = page.getByRole('dialog', { name: label });
	await dialog.getByPlaceholder('値を入力').fill(value);
	await dialog.getByRole('button', { name: '適用' }).click();
}

/** Reopen a column's filter and clear it (クリア), leaving the grid unfiltered on that column. */
async function clearColumnFilter(page: Page, columnHeader: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label }).click();
	await page.getByRole('dialog', { name: label }).getByRole('button', { name: 'クリア' }).click();
}

/** A grid data row (role="row") whose rendered text contains `text` - matches both the header row and data rows structurally, so callers should pass text unique to a data row. */
function rowWithText(page: Page, text: string): Locator {
	return page.getByRole('row').filter({ hasText: text });
}

/** Opens the header's user menu and clicks "ログアウト" (Header.svelte moved logout off a bare header button into the shared Menu component - visual-refresh-design.md §8.2). */
async function logout(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
	await page.getByRole('menuitem', { name: 'ログアウト' }).click();
}

/** Issue #260 実装-3 (wiring ②): the change-of-user notice (messages/ja.json `session.ownerChanged`). */
const OWNER_CHANGED_NOTICE = '別のユーザーでログインされました';

/** Issue #214: the unsaved-changes guard's prompt (messages/ja.json `unsaved.confirmLeave`). */
const LEAVE_PROMPT = '保存していない変更があります。変更を破棄してこの画面から移動しますか？';

/**
 * Answers `window.confirm` dialogs from a queue and records every message, so
 * a test can assert both that a prompt appeared and that NO unexpected one
 * did. A dialog with no queued answer is dismissed (= "stay"), which also
 * makes an unexpected prompt fail the following URL assertion.
 */
function trackDialogs(page: Page): {
	messages: string[];
	answer(accept: boolean): void;
	stop(): void;
} {
	const messages: string[] = [];
	const answers: boolean[] = [];
	const onDialog = (dialog: Dialog) => {
		messages.push(dialog.message());
		void (answers.shift() ? dialog.accept() : dialog.dismiss());
	};
	page.on('dialog', onDialog);
	return {
		messages,
		answer: (accept) => answers.push(accept),
		stop: () => page.off('dialog', onDialog)
	};
}

test.describe.serial('Banto LAN/REST smoke', () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		// This manually-created shared page bypasses the config's `use`
		// context options, so reduced motion must be passed here explicitly.
		// Without it, View Transitions (visual-refresh-design.md §11.1) freeze
		// the OLD page's snapshot for the crossfade after each navigation and
		// locators can pin an element from the outgoing page (e.g. getByLabel
		// substring-matching a grid filter button right after goto /customers/new).
		page = await browser.newPage({ reducedMotion: 'reduce' });
	});

	test.afterAll(async () => {
		// Optional chaining: if beforeAll throws before `page` is assigned, an
		// unguarded page.close() raises a TypeError here that masks the real
		// failure cause (e.g. a missing Playwright browser).
		await page?.close();
	});

	test('1. first-run setup creates the admin account and reaches the dashboard', async () => {
		await page.goto('/login');

		// Fresh DB -> AuthProvider.status() reports uninitialized -> the login
		// page renders the setup form, not the login form (login/+page.svelte).
		await expect(page.getByRole('heading', { name: 'Banto Cost' })).toBeVisible();
		await expect(page.getByLabel('表示名')).toBeVisible();

		await page.getByLabel('表示名').fill(ADMIN_DISPLAY_NAME);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
		await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'アカウントを作成' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		// With public viewing disabled, reload restores the ordinary account
		// from the identity endpoint even though its username is "public".
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
	});

	test('2. logout returns to the login screen, then login restores the session', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('3. customers: create, appears in the list, edit, and the edit persists', async () => {
		for (const name of [CUSTOMER_A, CUSTOMER_B]) {
			await page.goto('/customers');
			await page.getByRole('button', { name: '顧客を登録' }).click();
			await expect(page).toHaveURL(/\/customers\/new$/);
			await page.getByLabel('顧客名').fill(name);
			await page.getByRole('button', { name: '保存' }).click();
			await expect(page).toHaveURL(/\/customers$/);
		}

		await applyColumnFilter(page, '顧客名', CUSTOMER_A);
		const row = rowWithText(page, CUSTOMER_A);
		await expect(row).toBeVisible();
		await expect(rowWithText(page, CUSTOMER_B)).toHaveCount(0);
		await clearColumnFilter(page, '顧客名');
		await expect(rowWithText(page, CUSTOMER_B)).toBeVisible();

		const openLink = row.getByRole('link', { name: '開く' });
		const href = await openLink.getAttribute('href');
		expect(href).toMatch(/^\/customers\/\d+$/);
		await openLink.click();
		await expect(page).toHaveURL(new RegExp(`${href}$`));
		await expect(page.getByLabel('顧客名')).toHaveValue(CUSTOMER_A);
		await page.getByLabel('顧客名').fill(CUSTOMER_A_RENAMED);
		await page.getByLabel('備考').fill('E2E備考');
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/customers$/);

		// Re-open by URL (not through the grid) to confirm the server kept it.
		await page.goto(href!);
		await expect(page.getByLabel('顧客名')).toHaveValue(CUSTOMER_A_RENAMED);
		await expect(page.getByLabel('備考')).toHaveValue('E2E備考');

		// An id that is not a record shows the not-found state.
		await page.goto('/customers/999999');
		await expect(page.getByText('顧客が見つかりません')).toBeVisible();
	});

	// The dashboard's 案件と売上の要約 reads the server aggregates: one project
	// with an adopted estimate (¥1,000,000 at 50%, revenue planned next month)
	// and one without any adopted version (= needs attention).
	test('3g. dashboard: the summary shows the pipeline, the outlook and the projects needing attention', async () => {
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		const months = await thisAndNextMonth(page);
		const users = await api<{ id: number; username: string }[]>(page, 'GET', '/api/users');
		const manager = users.find((user) => user.username === ADMIN_USERNAME)!;
		// Narrow the first administrator (who gets every capability at setup,
		// design 2.5) to the sales / amount / company-report capabilities.
		await api(page, 'PUT', `/api/users/${manager.id}/capabilities`, {
			capabilities: ['pipeline.edit', 'amount.view', 'report.all']
		});
		const customers = await api<{ rows: { id: number; name: string }[] }>(
			page,
			'POST',
			'/api/customers/list',
			{}
		);
		const customer = customers.rows.find((row) => row.name === CUSTOMER_B)!;
		const project = (code: string, name: string) =>
			api<{ id: number }>(page, 'POST', '/api/projects', {
				code,
				name,
				customerId: customer.id,
				managerUserId: manager.id,
				status: 'quoting'
			});
		const estimated = await project(`E2E-${RUN}-1`, 'E2E見込あり案件');
		await project(`E2E-${RUN}-2`, 'E2E採用版なし案件');
		await api(page, 'POST', `/api/projects/${estimated.id}/pipeline-versions`, {
			stage: 'quoting',
			expectedAmount: 1_000_000,
			probabilityPct: 50,
			expectedOrderMonth: months.current,
			expectedStartMonth: null,
			expectedEndMonth: null,
			estCostAtOrder: null,
			basis: 'E2E見積提出',
			nextAction: null,
			confirmedOn: null,
			revenuePlan: [{ month: months.next, amount: 1_000_000 }],
			adopt: true
		});

		await page.reload();
		const tile = (id: string) => page.locator(`[data-tile="${id}"] .stat-value`);
		await expect(tile('pipeline-total')).toHaveText('¥1,000,000');
		await expect(tile('pipeline-weighted')).toHaveText('¥500,000');
		await expect(tile('outlook-this-month')).toHaveText('¥0');
		await expect(tile('outlook-next-month')).toHaveText('¥500,000');
		await expect(tile('attention')).toHaveText('1 件');

		// Each business screen is one click away.
		await page.getByRole('link', { name: /^案件見込 受注前/ }).click();
		await expect(page).toHaveURL(/\/pipeline$/);
		await expect(page.getByText('E2E見込あり案件').first()).toBeVisible();
	});

	// Issue #214: leaving the customer form with unsaved input asks first. "Stay"
	// keeps the input, "leave" moves; no prompt after a save, after undoing
	// the edit, or for a clean form.
	test('3a. customers: unsaved input asks before leaving, save and a clean form do not', async () => {
		const dialogs = trackDialogs(page);
		const unsaved = page.getByText('未保存の変更があります');
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		try {
			await page.goto('/customers/new');
			const name = page.getByLabel('顧客名');
			await expect(name).toBeVisible();
			await expect(unsaved).toHaveCount(0);

			await name.fill('E2E未保存の入力');
			await expect(unsaved).toBeVisible();

			// Stay: the navigation is cancelled and the input survives.
			dialogs.answer(false);
			await mainNav.getByRole('link', { name: 'ダッシュボード' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/customers\/new$/);
			await expect(name).toHaveValue('E2E未保存の入力');
			await expect(page.getByRole('button', { name: '保存' })).toBeEnabled();

			// Leave via the form's own "back to list" (= cancel).
			dialogs.answer(true);
			await page.getByRole('link', { name: '一覧へ戻る' }).click();
			await expect(page).toHaveURL(/\/customers$/);
			expect(dialogs.messages).toHaveLength(2);

			// Typing and then undoing the edit is not "unsaved".
			await page.getByRole('button', { name: '顧客を登録' }).click();
			await expect(page).toHaveURL(/\/customers\/new$/);
			await page.getByLabel('顧客名').fill('一時的');
			await expect(unsaved).toBeVisible();
			await page.getByLabel('顧客名').fill('');
			await expect(unsaved).toHaveCount(0);
			// Blur first: the now-empty required field shows its error on
			// blur, which shifts the footer - clicking straight away would let
			// that layout shift swallow the click.
			await page.getByLabel('顧客名').blur();
			await expect(page.getByText('必須項目です')).toBeVisible();
			await page.getByRole('link', { name: '一覧へ戻る' }).click();
			await expect(page).toHaveURL(/\/customers$/);

			// A successful save goes back to the list without a prompt.
			await page.getByRole('button', { name: '顧客を登録' }).click();
			await expect(page).toHaveURL(/\/customers\/new$/);
			await page.getByLabel('顧客名').fill(`E2E未保存ガード-${Date.now()}`);
			const created = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/customers' &&
					response.request().method() === 'POST'
			);
			await page.getByRole('button', { name: '保存' }).click();
			expect((await created).ok()).toBe(true);
			await expect(page).toHaveURL(/\/customers$/);
			expect(dialogs.messages).toHaveLength(2);
		} finally {
			dialogs.stop();
		}
	});

	// Owner review on PR #232: agreeing to leave while a save is in flight,
	// then the save finishing BEFORE the chosen screen has loaded, must still
	// end on the chosen screen - not be overridden by the post-save goto back
	// to the list. The save reply and the chosen screen's code (its route
	// chunk - this page was freshly loaded, so the dashboard's is not in the
	// module cache yet) are both held so the order is fixed:
	// agree to leave -> save succeeds -> the chosen screen finishes loading.
	test('3b. customers: a save that finishes after agreeing to leave does not override the chosen screen', async () => {
		const dialogs = trackDialogs(page);
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		let releaseSave!: () => void;
		const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
		let releaseChunks!: () => void;
		const chunkGate = new Promise<void>((resolve) => (releaseChunks = resolve));
		let chunkHeld = false;
		try {
			await page.goto('/customers/new');
			await page.getByLabel('顧客名').fill(`E2E離脱中の保存-${Date.now()}`);

			await page.route('**/api/customers', async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				await saveGate;
				return route.continue();
			});
			const created = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/customers' &&
					response.request().method() === 'POST'
			);
			await page.getByRole('button', { name: '保存' }).click();

			// Hold every app chunk requested from now on: the chosen screen
			// cannot finish loading until they are released.
			await page.route('**/_app/immutable/**', async (route) => {
				chunkHeld = true;
				await chunkGate;
				return route.continue();
			});
			dialogs.answer(true);
			await mainNav.getByRole('link', { name: 'ダッシュボード' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect.poll(() => chunkHeld).toBe(true);

			// The save wins the race while the dashboard is still loading.
			releaseSave();
			expect((await created).ok()).toBe(true);
			await expect(page.getByText('保存しました')).toBeVisible();

			releaseChunks();
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(page).toHaveURL(/\/dashboard$/);
			expect(dialogs.messages).toHaveLength(1);
		} finally {
			releaseSave();
			releaseChunks();
			await page.unrouteAll({ behavior: 'wait' });
			dialogs.stop();
		}
		// A late goto('/customers') would have replaced the dashboard by now:
		// every request it makes has been let through above.
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	// Issue #290: SvelteKit reuses the page component between two URLs of the
	// same route (customers/1 -> customers/2 only updates `page.params`). The detail
	// page reads its id once at setup, so without the (app) layout keying the
	// page on its params the URL moved on while the form and
	// save target stayed on the previous record (a save then PUT the WRONG id).
	// Every hop here is a client-side navigation (anchor click handled by
	// SvelteKit / history), never a full page load.
	test('3f. customers: moving between two detail URLs (SPA) keeps URL, form and save target on the same record', async () => {
		const dialogs = trackDialogs(page);
		/** Click a plain anchor to `href`: SvelteKit turns it into a client-side navigation. */
		const spa = (href: string) =>
			page.evaluate((href) => {
				const a = document.createElement('a');
				a.href = href;
				document.body.appendChild(a);
				a.click();
				a.remove();
			}, href);
		const readCustomer = (id: number) =>
			page.evaluate(async (id) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const res = await fetch(`/api/customers/${id}`, {
					headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
				});
				return (await res.json()) as { name: string };
			}, id);
		const name = page.getByLabel('顧客名');
		try {
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			const a = await readCustomer(1);
			const b = await readCustomer(2);
			expect(a.name).not.toBe(b.name);

			// Saves are answered by the test (echoing the body), so scenario 3's data
			// is untouched and the request path says which record was targeted.
			const puts: string[] = [];
			await page.route('**/api/customers/*', async (route) => {
				const request = route.request();
				if (request.method() !== 'PUT') return route.fallback();
				puts.push(new URL(request.url()).pathname);
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: request.postData() ?? '{}'
				});
			});

			// B -> A directly (the case that reuses the component).
			await spa('/customers/2');
			await expect(page).toHaveURL(/\/customers\/2$/);
			await expect(name).toHaveValue(b.name);
			await spa('/customers/1');
			await expect(page).toHaveURL(/\/customers\/1$/);
			await expect(name).toHaveValue(a.name);

			// The user-visible form is A's, so the save must target A.
			await name.fill(`${a.name}-3f`);
			await page.getByRole('button', { name: '保存' }).click();
			await expect(page).toHaveURL(/\/customers$/);
			expect(puts).toEqual(['/api/customers/1']);

			// History: A -> list -> B, then back to the list and back to A.
			await spa('/customers/1');
			await expect(page).toHaveURL(/\/customers\/1$/);
			await expect(name).toHaveValue(a.name);
			await spa('/customers');
			await expect(page).toHaveURL(/\/customers$/);
			await spa('/customers/2');
			await expect(page).toHaveURL(/\/customers\/2$/);
			await expect(name).toHaveValue(b.name);
			await page.goBack();
			await expect(page).toHaveURL(/\/customers$/);
			await page.goBack();
			await expect(page).toHaveURL(/\/customers\/1$/);
			await expect(name).toHaveValue(a.name);

			// An unsaved edit is still guarded when the move is to ANOTHER detail
			// URL: staying keeps the edit and the URL.
			await name.fill('E2E未保存-3f');
			dialogs.answer(false);
			await spa('/customers/2');
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/customers\/1$/);
			await expect(name).toHaveValue('E2E未保存-3f');
			// Leaving discards it and shows B.
			dialogs.answer(true);
			await spa('/customers/2');
			await expect(page).toHaveURL(/\/customers\/2$/);
			await expect(name).toHaveValue(b.name);
			expect(dialogs.messages).toHaveLength(2);

			// A slow answer for the page we already left must not land on the
			// page we are on now: hold B's GET, move on to A, then release it.
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/api/customers/2', async (route) => {
				if (route.request().method() !== 'GET') return route.fallback();
				await gate;
				await route.fallback();
			});
			await spa('/customers');
			await expect(page).toHaveURL(/\/customers$/);
			await spa('/customers/2');
			await expect(page).toHaveURL(/\/customers\/2$/);
			await spa('/customers/1');
			await expect(page).toHaveURL(/\/customers\/1$/);
			await expect(name).toHaveValue(a.name);
			release();
			await page.waitForTimeout(300);
			await expect(page).toHaveURL(/\/customers\/1$/);
			await expect(name).toHaveValue(a.name);

			// An id that cannot be a record, between two valid ones: not found,
			// and the next valid id loads normally (no stale "valid" state).
			await spa('/customers/abc');
			await expect(page.getByText('が見つかりません').first()).toBeVisible();
			await expect(name).toHaveCount(0);
			await spa('/customers/2');
			await expect(page).toHaveURL(/\/customers\/2$/);
			await expect(name).toHaveValue(b.name);
		} finally {
			dialogs.stop();
			await page.unroute('**/api/customers/*');
			await page.unroute('**/api/customers/2');
		}
	});

	test('5. user management: create a viewer account and preserve selection across replies', async () => {
		test.setTimeout(60_000);
		await page.goto('/users');

		// Scoped to the create form (not just page.getByLabel(...)): the
		// grid's ユーザー名/表示名 column filter buttons below (aria-label
		// "<列名>の絞り込み") also match those label texts by substring,
		// which makes an unscoped getByLabel ambiguous once the grid is on
		// the same page (users/+page.svelte's "section.create").
		const createForm = page.locator('section.create');
		await expect(createForm.getByLabel('パスワード（8文字以上）')).toHaveCSS(
			'border-bottom-width',
			'2px'
		);
		const createFont = await createForm
			.getByLabel('ユーザー名')
			.evaluate((element) => getComputedStyle(element).fontSize);
		await createForm.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
		await createForm.getByLabel('パスワード（8文字以上）').fill(VIEWER_PASSWORD);
		await createForm.getByLabel('表示名').fill(VIEWER_DISPLAY_NAME);
		await createForm.getByLabel('ロール').selectOption('viewer');
		await createForm.getByRole('button', { name: '作成' }).click();

		await expect(rowWithText(page, VIEWER_USERNAME)).toBeVisible();

		// #206: a reply for an earlier selection must not replace the panel
		// while leaving another user's draft attached to the wrong identity.
		const panel = page.locator('.edit-column');
		const displayName = panel.getByLabel('表示名', { exact: true });
		const role = panel.getByLabel('ロール');
		const save = panel.getByRole('button', { name: '保存', exact: true });
		const viewerRow = rowWithText(page, VIEWER_USERNAME);
		const adminRow = rowWithText(page, ADMIN_USERNAME);
		async function selectUserRow(username: string): Promise<void> {
			await rowWithText(page, username).locator('[data-cell-field="username"]').click();
			// Activate the selected read-only row through the grid's keyboard
			// contract; assert the panel before testing asynchronous mutations.
			await page.keyboard.press('Enter');
			await expect(panel.getByRole('heading', { level: 2 })).toContainText(username);
		}
		const viewerId = Number(await viewerRow.locator('[data-cell-field="id"]').innerText());
		const adminId = Number(await adminRow.locator('[data-cell-field="id"]').innerText());
		expect(viewerId).toBeGreaterThan(0);
		expect(adminId).toBeGreaterThan(0);

		for (const outcome of ['success', 'failure', 'reselect'] as const) {
			await selectUserRow(VIEWER_USERNAME);
			await expect(displayName).toHaveCSS('font-size', createFont);
			await expect(role).toHaveCSS('border-bottom-width', '2px');
			const savedName = `${VIEWER_DISPLAY_NAME}-${outcome}`;
			await displayName.fill(savedName);
			if (outcome === 'reselect') await role.selectOption('editor');
			let releaseReply!: () => void;
			const replyGate = new Promise<void>((resolve) => (releaseReply = resolve));
			let requestArrived!: () => void;
			const arrived = new Promise<void>((resolve) => (requestArrived = resolve));
			const pendingReplies = new Set<Promise<void>>();
			await page.route(`**/api/users/${viewerId}`, (route) => {
				if (route.request().method() !== 'PUT') return route.continue();
				const pending = (async () => {
					// Successful saves reach the real API, including its normal auth
					// and CSRF headers; only delivery of the reply is delayed.
					const response = outcome === 'failure' ? null : await route.fetch();
					if (response) expect(response.ok()).toBe(true);
					requestArrived();
					await replyGate;
					if (response) await route.fulfill({ response });
					else
						await route.fulfill({
							status: 500,
							json: { kind: 'other', message: 'E2E delayed user save failure' }
						});
				})();
				pendingReplies.add(pending);
				return pending.finally(() => pendingReplies.delete(pending));
			});
			try {
				await save.click();
				await arrived;
				await selectUserRow(ADMIN_USERNAME);
				if (outcome === 'reselect') await selectUserRow(VIEWER_USERNAME);
				const targetUsername = outcome === 'reselect' ? VIEWER_USERNAME : ADMIN_USERNAME;
				const targetId = outcome === 'reselect' ? viewerId : adminId;
				const targetRole = outcome === 'reselect' ? 'viewer' : 'admin';
				const draft = `E2E newer ${outcome} draft`;
				await displayName.fill(draft);
				await expect(role).toHaveValue(targetRole);
				const lateReply = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname === `/api/users/${viewerId}` &&
						response.request().method() === 'PUT'
				);
				releaseReply();
				await (await lateReply).finished();
				if (outcome === 'failure') {
					await expect(
						page.getByText('E2E delayed user save failure', { exact: true })
					).toBeVisible();
				} else {
					await expect(viewerRow.locator('[data-cell-field="displayName"]')).toHaveText(savedName);
				}
				await expect(panel.getByRole('heading', { level: 2 })).toContainText(targetUsername);
				await expect(displayName).toHaveValue(draft);
				if (outcome === 'reselect') {
					// An ID-only guard would accept the old A reply and replace
					// this new selection's saved-role badge with editor.
					await expect(panel.locator('.role-row')).toHaveText('閲覧者');
				}
				await expect(role).toHaveValue(targetRole);
				await expect(save).toBeEnabled();

				const subsequentSave = page.waitForRequest(
					(request) =>
						/\/api\/users\/\d+$/.test(new URL(request.url()).pathname) && request.method() === 'PUT'
				);
				await save.click();
				const request = await subsequentSave;
				expect(new URL(request.url()).pathname).toBe(`/api/users/${targetId}`);
				expect(request.postDataJSON()).toEqual({ displayName: draft, role: targetRole });
				await expect(
					rowWithText(page, targetUsername).locator('[data-cell-field="displayName"]')
				).toHaveText(draft);
				if (outcome === 'success') {
					await expect(viewerRow.locator('[data-cell-field="displayName"]')).toHaveText(savedName);
				}
			} finally {
				releaseReply();
				while (pendingReplies.size > 0) await Promise.all([...pendingReplies]);
				await page.unrouteAll({ behavior: 'wait' });
			}
		}

		// A password-reset reply must also leave the newly selected user's
		// password draft alone. Reset only the viewer to its existing password.
		await selectUserRow(VIEWER_USERNAME);
		const password = panel.getByLabel('新しいパスワード（8文字以上）', { exact: true });
		await expect(password).toHaveCSS('font-size', createFont);
		await expect(password).toHaveCSS('border-bottom-width', '2px');
		await password.fill(VIEWER_PASSWORD);
		let releaseReset!: () => void;
		const resetGate = new Promise<void>((resolve) => (releaseReset = resolve));
		let resetArrived!: () => void;
		const resetStarted = new Promise<void>((resolve) => (resetArrived = resolve));
		const pendingResets = new Set<Promise<void>>();
		await page.route(`**/api/users/${viewerId}/reset-password`, (route) => {
			const pending = (async () => {
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				resetArrived();
				await resetGate;
				await route.fulfill({ response });
			})();
			pendingResets.add(pending);
			return pending.finally(() => pendingResets.delete(pending));
		});
		try {
			await panel.getByRole('button', { name: 'パスワードをリセット', exact: true }).click();
			await resetStarted;
			await selectUserRow(ADMIN_USERNAME);
			await password.fill('E2E unsent admin password');
			releaseReset();
			await expect(page.getByText('パスワードをリセットしました', { exact: true })).toBeVisible();
			await expect(panel.getByRole('heading', { level: 2 })).toContainText(ADMIN_USERNAME);
			await expect(password).toHaveValue('E2E unsent admin password');
		} finally {
			releaseReset();
			while (pendingResets.size > 0) await Promise.all([...pendingResets]);
			await page.unrouteAll({ behavior: 'wait' });
		}

		// Later scenarios log into the viewer account; preserve both roles and
		// restore display names through the same UI after exercising the race.
		for (const [username, name] of [
			[VIEWER_USERNAME, VIEWER_DISPLAY_NAME],
			[ADMIN_USERNAME, ADMIN_DISPLAY_NAME]
		]) {
			await selectUserRow(username);
			await displayName.fill(name);
			await save.click();
			await expect(
				rowWithText(page, username).locator('[data-cell-field="displayName"]')
			).toHaveText(name);
		}
	});

	test('5a. users: a row click right after opening the page opens its edit panel (#236)', async () => {
		await page.goto('/users');
		// No wait between the page load and the click: the click must work in
		// the state the user first sees.
		const grid = page.getByRole('grid');
		const cell = rowWithText(page, ADMIN_USERNAME).locator('[data-cell-field="username"]');
		await expect(cell).toBeVisible();
		// Precondition that makes this scenario meaningful: the grid sits below
		// the create form and runs past the bottom of the viewport. Focusing it
		// on pointerdown without `preventScroll` scrolled the page between press
		// and release, so the click landed on the grid instead of the cell and
		// onRowClick never ran (the cell was still selected). If the layout ever
		// fits the whole grid on screen, this fails instead of passing vacuously.
		const gridBottom = await grid.evaluate((element) => element.getBoundingClientRect().bottom);
		const viewportHeight = page.viewportSize()!.height;
		expect(gridBottom).toBeGreaterThan(viewportHeight);
		// The clicked cell itself must be fully on screen. Otherwise click()'s
		// own actionability scroll would move the page too, and the scrollY
		// comparison below could no longer tell it from a focus() scroll.
		const cellBox = await cell.boundingBox();
		expect(cellBox, 'the clicked cell must have a layout box').not.toBeNull();
		expect(
			cellBox!.y >= 0 && cellBox!.y + cellBox!.height <= viewportHeight,
			`precondition: the clicked cell (y=${cellBox!.y}, height=${cellBox!.height}) must lie fully inside the ${viewportHeight}px viewport, or click() auto-scrolls and the scroll check below is meaningless`
		).toBe(true);
		const scrollBefore = await page.evaluate(() => window.scrollY);

		await cell.click();

		await expect(page.locator('.edit-column').getByRole('heading', { level: 2 })).toContainText(
			ADMIN_USERNAME
		);
		expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
	});

	test('5b. delayed deletion preserves another user but closes a reselected deleted user', async () => {
		test.setTimeout(60_000);
		await page.goto('/users');
		const createForm = page.locator('section.create');
		const panel = page.locator('.edit-column');
		const displayName = panel.getByLabel('表示名', { exact: true });
		async function selectUserRow(username: string): Promise<void> {
			await rowWithText(page, username).locator('[data-cell-field="username"]').click();
			await page.keyboard.press('Enter');
			await expect(panel.getByRole('heading', { level: 2 })).toContainText(username);
		}

		for (const reselect of [false, true]) {
			// Real disposable accounts: the existing viewer is needed by scenario 6.
			const username = `e2e-delete-${reselect ? 'reselect' : 'other'}`;
			await createForm.getByLabel('ユーザー名').fill(username);
			await createForm.getByLabel('パスワード（8文字以上）').fill(VIEWER_PASSWORD);
			await createForm.getByLabel('表示名').fill('E2E削除対象');
			await createForm.getByLabel('ロール').selectOption('viewer');
			await createForm.getByRole('button', { name: '作成' }).click();
			const deletedRow = rowWithText(page, username);
			await expect(deletedRow).toBeVisible();
			const id = Number(await deletedRow.locator('[data-cell-field="id"]').innerText());
			expect(id).toBeGreaterThan(0);
			await selectUserRow(username);

			let releaseDelete!: () => void;
			const replyGate = new Promise<void>((resolve) => (releaseDelete = resolve));
			let deleteArrived!: () => void;
			const deleted = new Promise<void>((resolve) => (deleteArrived = resolve));
			const pendingReplies = new Set<Promise<void>>();
			await page.route(`**/api/users/${id}`, (route) => {
				if (route.request().method() !== 'DELETE') return route.continue();
				const pending = (async () => {
					// Delete in the real database now, but let the user change
					// selection before the browser receives the success response.
					const response = await route.fetch();
					expect(response.status()).toBe(204);
					deleteArrived();
					await replyGate;
					await route.fulfill({ response });
				})();
				pendingReplies.add(pending);
				return pending.finally(() => pendingReplies.delete(pending));
			});
			try {
				page.once('dialog', (dialog) => dialog.accept());
				await panel.getByRole('button', { name: '削除', exact: true }).click();
				await deleted;
				await selectUserRow(ADMIN_USERNAME);
				if (reselect) await selectUserRow(username);
				const draft = 'E2E draft during deletion';
				await displayName.fill(draft);
				releaseDelete();
				// Row removal establishes that the delayed callback and its list
				// refresh completed before inspecting the selected edit panel.
				await expect(deletedRow).toHaveCount(0);
				if (reselect) {
					await expect(
						panel.getByText('ユーザーを選択してください', { exact: true })
					).toBeVisible();
					await expect(panel.locator('input, select, button')).toHaveCount(0);
				} else {
					await expect(panel.getByRole('heading', { level: 2 })).toContainText(ADMIN_USERNAME);
					await expect(displayName).toHaveValue(draft);
					await expect(panel.getByLabel('ロール')).toHaveValue('admin');
					await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
				}
			} finally {
				releaseDelete();
				while (pendingReplies.size > 0) await Promise.all([...pendingReplies]);
				await page.unrouteAll({ behavior: 'wait' });
			}
		}
	});

	test('6. viewer role: no admin nav entries, no customer create button', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
		await page.getByLabel('パスワード').fill(VIEWER_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		// Sidebar.svelte hides adminOnly nav entries entirely (not just
		// disabled) for non-admin roles.
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '監査ログ' })).toHaveCount(0);

		// A viewer with no capability (design 第2章) cannot read the customer
		// master, and is never offered the create button.
		await page.goto('/customers');
		await expect(page.getByText('閲覧する権限がありません').first()).toBeVisible();
		await expect(page.getByRole('button', { name: '顧客を登録' })).toHaveCount(0);

		// §8-15: with no capability the nav lists no business screen (display
		// only - the server's refusal above stays the answer).
		await page.goto('/dashboard');
		await expect(page.locator('#app-sidebar').getByRole('link', { name: '顧客' })).toHaveCount(0);
		await expect(page.locator('#app-sidebar').getByRole('link', { name: '案件台帳' })).toHaveCount(
			0
		);
		// Without amount.view the amount tiles say so instead of the ¥0 / 0 件
		// of an empty scope (§8-15); 確認すること (P8g) likewise, never 0 件.
		await expect(page.locator('[data-tile="pipeline-total"] .stat-value')).toHaveText(
			'権限がありません'
		);
		await expect(page.locator('[data-tile="attention"] .stat-value')).toHaveText(
			'権限がありません'
		);
		await expect(page.locator('[data-tile="approvals"] .stat-value')).toHaveText(
			'権限がありません'
		);
		await expect(page.locator('[data-tile="fixed-costs-due"] .stat-value')).toHaveText(
			'権限がありません'
		);
	});

	// Issue #215/#255 6th review: the session is still valid (check() passes)
	// but its identity cannot be fetched for a moment (a 500). That is not
	// "nobody is signed in": the guard shows its retryable error page, and
	// nothing about the session - owner, generation - is changed, so the
	// retry restores the screen.
	test('6b. an identity outage keeps the session, and the retry restores the screen', async () => {
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

		const outage = (route: Route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ kind: 'other', message: 'identity outage' })
			});
		await page.route('**/api/auth/identity', outage);
		await page.reload();
		await expect(page.getByText('ログイン状態を確認できませんでした')).toBeVisible();
		await expect(page).toHaveURL(/\/dashboard$/);

		await page.unroute('**/api/auth/identity', outage);
		await page.getByRole('button', { name: '再試行' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
	});

	test('7. admin: audit log shows the login and customers records', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await page.goto('/audit-log');

		// action is stored/filtered on its raw wire value ('login'); the grid
		// cell renders it through actionLabel() as 'ログイン'.
		await applyColumnFilter(page, 'アクション', 'login');
		await expect(rowWithText(page, 'ログイン').first()).toBeVisible();

		// Filters AND together, so the previous one must be cleared before a
		// resource-only filter is applied, or nothing would match.
		await clearColumnFilter(page, 'アクション');
		await applyColumnFilter(page, 'リソース', 'customers');
		await expect(rowWithText(page, 'customers').first()).toBeVisible();
	});

	test('7a. audit log: a 0-row filter recovers when cleared, and reload shows failures and new records', async () => {
		// Issue #248. Continues on /audit-log from scenario 7 (resource filter set).
		const countNote = page.getByTestId('audit-count-note');
		const reload = page.getByRole('button', { name: '再読み込み', exact: true });
		await clearColumnFilter(page, 'リソース');
		await expect(countNote).toContainText('件の記録があります');

		// A filter that matches nothing is a real 0-row result, not "not loaded".
		await applyColumnFilter(page, 'アクション', 'no-such-action');
		await expect(countNote).toHaveText('該当する記録はありません（0件）。');
		// Clearing it must reach the server although the grid now reports an
		// empty window {0, 0} (the old page made no request here).
		await clearColumnFilter(page, 'アクション');
		await expect(countNote).toContainText('件の記録があります');
		const before = Number((await countNote.innerText()).replace(/[^0-9]/g, ''));
		expect(before).toBeGreaterThan(0);

		// A failed read is shown on the page (not only as a toast) and
		// "再読み込み" recovers from it.
		await page.route('**/api/audit-log/list**', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ kind: 'other', message: 'e2e: list failed' })
			})
		);
		await reload.click();
		await expect(
			page.getByRole('alert').filter({ hasText: '監査ログを読み込めませんでした' })
		).toBeVisible();
		await page.unrouteAll({ behavior: 'wait' });

		// Record one more entry (a no-op retention-policy save is audited as
		// settings_change). The list keeps its snapshot until "再読み込み".
		await page.evaluate(async () => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const headers = {
				'X-Banto-Client': 'banto',
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			};
			const current = await fetch('/api/audit-log/config', { headers });
			if (!current.ok) throw new Error(`get config failed: ${current.status}`);
			const saved = await fetch('/api/audit-log/config', {
				method: 'PUT',
				headers,
				body: JSON.stringify(await current.json())
			});
			if (!saved.ok) throw new Error(`put config failed: ${saved.status}`);
		});
		await reload.click();
		await expect(
			page.getByRole('alert').filter({ hasText: '監査ログを読み込めませんでした' })
		).toHaveCount(0);
		await expect(countNote).toContainText(
			`${(before + 1).toLocaleString('ja-JP')}件の記録があります`
		);
		await expect(rowWithText(page, '設定変更').first()).toBeVisible();
	});
	test('9. command palette: search and navigate to the audit log', async () => {
		await page.goto('/customers');
		// The Ctrl+K listener lives on (app)/+layout.svelte's `<svelte:window>`,
		// which only mounts after the route guard's async work (bantoReady,
		// the session confirmation) resolves - later than page.goto()'s "load"
		// event. Wait for a page-specific element first so the keypress below
		// isn't racing that mount.
		await expect(page.getByRole('button', { name: '顧客を登録' })).toBeVisible();

		await page.keyboard.press('Control+K');
		const search = page.getByPlaceholder('画面・操作を検索…');
		await expect(search).toBeVisible();
		await search.fill('監査');
		await search.press('Enter');

		await expect(page).toHaveURL(/\/audit-log$/);
	});

	// Issue #435 PR-11: Ctrl+K is a command of the app's shortcut dispatcher.
	// The open palette is its `ownerLayer`, so the key that closes it still
	// works from the palette's own search box (`allowInEditable`); an IME
	// composition never toggles it; a held key toggles once and its repeats are
	// still kept from the browser.
	test('9a. command palette: Ctrl+K closes it from its own search box; IME and held keys do not toggle it', async () => {
		await page.goto('/customers');
		await expect(page.getByRole('button', { name: '顧客を登録' })).toBeVisible();
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		const search = page.getByPlaceholder('画面・操作を検索…');

		/** Dispatch a synthetic Ctrl+K keydown at the focused element; was it consumed? */
		const ctrlK = (init: { isComposing?: boolean; repeat?: boolean }) =>
			page.evaluate((extra) => {
				const event = new KeyboardEvent('keydown', {
					key: 'k',
					code: 'KeyK',
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
					...extra
				});
				(document.activeElement ?? document.body).dispatchEvent(event);
				return event.defaultPrevented;
			}, init);

		await page.keyboard.press('Control+K');
		await expect(palette).toBeVisible();
		await search.fill('監');
		await expect(search).toBeFocused();
		await page.keyboard.press('Control+K');
		await expect(palette).toHaveCount(0);

		// Composing: left to the IME / browser, nothing toggles.
		expect(await ctrlK({ isComposing: true })).toBe(false);
		await expect(palette).toHaveCount(0);
		// An auto-repeat: consumed (no browser Ctrl+K), but it does not toggle.
		expect(await ctrlK({ repeat: true })).toBe(true);
		await expect(palette).toHaveCount(0);
	});

	test('10. header: the sun/moon button pins the opposite theme and sets data-theme', async () => {
		await page.goto('/settings');

		// The button shows the OPPOSITE of the theme on screen (the colour-mode
		// picker left the settings page). This run's browser follows a light OS,
		// so it starts as "switch to dark" and, once pressed, offers the way back.
		await page.getByRole('button', { name: 'ダークモードに切り替え' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect(page.getByRole('button', { name: 'ライトモードに切り替え' })).toBeVisible();
	});

	// Issue #214: the account page's password form is the save-type settings
	// form this LAN/REST run can reach (サーバ・接続 / セキュリティ drafts are
	// desktop-only). Unsaved input asks before switching category; a failed
	// save keeps it unsaved; "discard" and a successful save do not ask.
	test('10a. settings: unsaved password input asks before switching category', async () => {
		const dialogs = trackDialogs(page);
		const unsaved = page.getByText('未保存の変更があります');
		const categoryNav = page.getByRole('navigation', { name: '設定カテゴリ' });
		const current = page.getByLabel('現在のパスワード');
		const next = page.getByLabel('新しいパスワード（8文字以上）');
		const confirmNext = page.getByLabel('新しいパスワード（確認）');
		const changePassword = '**/api/auth/change-password';
		try {
			await categoryNav.getByRole('link', { name: 'アカウント' }).click();
			await expect(page).toHaveURL(/\/settings\/account$/);
			await expect(unsaved).toHaveCount(0);

			// Current credentials alone (including browser autofill) are not a
			// replacement password draft and must not block navigation.
			await current.fill('typed-but-not-saved');
			await expect(unsaved).toHaveCount(0);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect(page).toHaveURL(/\/settings\/appearance$/);
			expect(dialogs.messages).toHaveLength(0);
			await categoryNav.getByRole('link', { name: 'アカウント' }).click();
			await expect(page).toHaveURL(/\/settings\/account$/);
			await current.fill('typed-but-not-saved');
			await next.fill('E2eUnsavedNew1');
			await expect(unsaved).toBeVisible();

			dialogs.answer(false);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/settings\/account$/);
			await expect(current).toHaveValue('typed-but-not-saved');

			// A failed save keeps the input and the unsaved marker (network
			// failure stubbed: no password attempt reaches the server).
			await confirmNext.fill('E2eUnsavedNew1');
			await page.route(changePassword, (route) => route.abort());
			try {
				await page.getByRole('button', { name: 'パスワードを変更' }).click();
				await expect(page.locator('.settings-page .error')).toBeVisible();
			} finally {
				await page.unroute(changePassword);
			}
			await expect(unsaved).toBeVisible();
			await expect(current).toHaveValue('typed-but-not-saved');

			// Explicit discard clears it: switching category no longer asks.
			await page.getByRole('button', { name: '変更を取り消す' }).click();
			await expect(current).toHaveValue('');
			await expect(unsaved).toHaveCount(0);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect(page).toHaveURL(/\/settings\/appearance$/);
			expect(dialogs.messages).toHaveLength(1);

			// A successful save (stubbed, so the admin password stays as is)
			// clears the form: switching category does not ask either.
			await categoryNav.getByRole('link', { name: 'アカウント' }).click();
			await expect(page).toHaveURL(/\/settings\/account$/);
			await current.fill(ADMIN_PASSWORD);
			await next.fill('E2eUnsavedNew1');
			await confirmNext.fill('E2eUnsavedNew1');
			await page.route(changePassword, (route) =>
				route.fulfill({ status: 200, json: { success: true } })
			);
			try {
				await page.getByRole('button', { name: 'パスワードを変更' }).click();
				await expect(current).toHaveValue('');
			} finally {
				await page.unroute(changePassword);
			}
			await expect(unsaved).toHaveCount(0);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect(page).toHaveURL(/\/settings\/appearance$/);
			expect(dialogs.messages).toHaveLength(1);
		} finally {
			dialogs.stop();
		}
	});

	test('11. backups: create a backup and see it in the list', async () => {
		// settings-routes step 2 (choiapp-feedback-2026-09 §3.2): backups live
		// on the データ管理 category's own route now, not on `/settings`
		// (which redirects to 外観・言語).
		await page.goto('/settings/data');

		const backupRows = page.locator('.backup-list li');
		await expect(backupRows).toHaveCount(0);

		await page.getByRole('button', { name: '今すぐバックアップ' }).click();
		await expect(backupRows).toHaveCount(1);
	});

	// Copilot review on PR #198 (settings-routes step 2): authSettingsStore/
	// systemInfoStore used to be loaded by whichever section's own mount
	// effect happened to own the fetch (SecuritySection/ConnectivitySection),
	// which silently no-oped on a direct visit to any OTHER category's route
	// since that section never mounts there. The fix moved both initial
	// loads to the persistent `settings/+layout.svelte`. Assert that
	// directly - not via scenario 11's `/settings/data` visit above, which
	// would still pass even if the layout-level load were broken as long as
	// ConnectivitySection had happened to run first in the same session -
	// by going straight to `/settings/connectivity` and confirming the
	// System Info card (systemInfoStore) is populated, plus that the nav
	// marks the current category via `aria-current` (base-aware `isActive`).
	test('11a. settings: a direct visit to /settings/connectivity loads System Info via the layout', async () => {
		await page.goto('/settings/connectivity');

		await expect(page.getByRole('link', { name: 'サーバ・接続' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page.getByText('sqlite', { exact: false })).toBeVisible();
	});

	// Nav badge (choiapp-feedback-2026-09 §4.1): a `resource_changed` server
	// event for a resource whose page is NOT on screen shows an
	// unseen-updates badge on that resource's sidebar entry
	// (#lib/navBadges.svelte.ts), and visiting the page clears it. The
	// "another client" is simulated by calling the REST API directly from
	// the page context with the session's own bearer token - the server
	// broadcasts the same SSE event either way. Customers are never deleted,
	// so this leaves one timestamped customer behind (later scenarios do not
	// count customers).
	test('13. sidebar: a customer change from another client shows an unseen-updates badge', async () => {
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

		const badge = page.locator('.nav-badge');
		const customersBadge = page.locator('a[href$="/customers"] .nav-badge');
		await expect(badge).toHaveCount(0);

		const created = await api<{ id: number; rowVersion: number }>(page, 'POST', '/api/customers', {
			name: `E2Eバッジ確認-${RUN}`,
			active: true
		});

		// SSE delivery -> onInvalidate('customers') -> badge on 顧客 (the
		// auto-retrying expect absorbs the event latency).
		await expect(customersBadge).toHaveText('1');

		// An update from the other client is counted too.
		await api(page, 'PUT', `/api/customers/${created.id}`, {
			name: `E2Eバッジ確認（改）-${RUN}`,
			active: true,
			rowVersion: created.rowVersion
		});
		await expect(customersBadge).toHaveText('2');
		// Only the 顧客 entry: a customer write is not a project change.
		await expect(badge).toHaveCount(1);

		// Landing on the page marks the changes as seen.
		await page.goto('/customers');
		await expect(badge).toHaveCount(0);
	});

	// Issue #204 review: a session the server could not verify (500 from the
	// session check - `/api/auth/identity` since Issue #260 実装-2) stays - regular and "Remember me" tokens alike - and
	// resumes after "再試行". Public viewing is OFF on this server, so the old
	// behavior would have bounced to /login.
	test('13a. an auth-check outage keeps the session instead of logging out', async () => {
		await expectCheckOutageKeepsTheSession(page, false);

		await logout(page);
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByLabel('ログイン状態を保持する（30日間）').check();
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await expectCheckOutageKeepsTheSession(page, true);
	});

	// Issue #321 (follow-up to #286): a protected screen opened directly while
	// the server is unreachable. The route guard used to wait for startup, and
	// on a first load SvelteKit draws nothing until the loads finish - so the
	// screen stayed blank with no way to reconnect. Now the splash shows
	// "起動中…" then "サーバーに接続できません" + 再接続 on the protected URL
	// itself (never demo, #286), and once the server is back the reconnect
	// opens that same screen with the session kept (Remember me from 13a).
	test('13a2. a protected screen opened while the server is unreachable offers reconnect and then opens', async () => {
		const serverDown = (route: Route) => route.abort('connectionrefused');
		await page.route('**/api/**', serverDown);
		try {
			await page.goto('/dashboard');
			await expect(page.getByRole('status')).toHaveText('起動中…');
			const unreachable = page.getByRole('alert');
			// 3 probes 1.5 s apart (STARTUP_AUTO_RETRIES) before the screen appears.
			await expect(unreachable).toContainText('サーバーに接続できません', { timeout: 15_000 });
			await expect(page).toHaveURL(/\/dashboard$/);
			await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		} finally {
			await page.unroute('**/api/**', serverDown);
		}

		await page.getByRole('alert').getByRole('button', { name: '再接続' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.getByText('サーバーに接続できません')).toHaveCount(0);
	});

	// Issue #241: a session revoked while its screen is open. A second
	// browser (its own storage) logs in as the viewer with "Remember me"; the
	// admin page then resets that account's password (Issue #204: this ends
	// every session of the account). The viewer's event stream is closed by
	// the server's periodic revalidation (15 s), its reconnect gets a `401`,
	// the session check confirms it (`/api/auth/identity` answers `200 null`
	// since Issue #260 実装-2) and clears the stored token, and the route
	// guard sends the open screen to /login. The stream must then stop
	// retrying (it used to retry every 3 s forever).
	test('13b. a session revoked from another session leaves its open screen for the login page', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const other = await context.newPage();
		try {
			const events: { at: number; status: number }[] = [];
			const checks: { status: number; body: string }[] = [];
			other.on('response', async (response) => {
				const path = new URL(response.url()).pathname;
				if (path === '/api/events') events.push({ at: Date.now(), status: response.status() });
				if (path === '/api/auth/identity') {
					checks.push({ status: response.status(), body: await response.text() });
				}
			});

			await other.goto('/login');
			await other.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await other.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await other.getByLabel('ログイン状態を保持する（30日間）').check();
			const streamOpened = other.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/events' && response.status() === 200
			);
			await other.getByRole('button', { name: 'ログイン' }).click();
			await expect(other).toHaveURL(/\/dashboard$/);
			await streamOpened;
			expect(
				await other.evaluate(() => localStorage.getItem('banto.auth.token')),
				'a Remember me token'
			).toBeTruthy();

			// Reset the viewer's password (to the same value, so nothing else in
			// this suite changes) from the admin's own session.
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
					const viewer = rows.find((row) => row.username === username);
					if (!viewer) throw new Error('viewer account not found');
					const reset = await fetch(`/api/users/${viewer.id}/reset-password`, {
						method: 'POST',
						headers: { ...headers, 'Content-Type': 'application/json' },
						body: JSON.stringify({ newPassword: password })
					});
					if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
				},
				{ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }
			);

			// Up to one revalidation interval (15 s) + one reconnect (3 s).
			await expect(other).toHaveURL(/\/login$/, { timeout: 40_000 });
			expect(
				await other.evaluate(() => ({
					local: localStorage.getItem('banto.auth.token'),
					session: sessionStorage.getItem('banto.auth.token')
				})),
				'the revoked token is cleared'
			).toEqual({ local: null, session: null });
			expect(checks, 'the session check confirmed the revocation').toContainEqual({
				status: 200,
				body: 'null'
			});

			// The stream stops: after its one 401 there is no further request.
			// The only fixed wait in this file - "nothing more happens" needs a
			// window; 2 reconnect intervals (3 s each) plus margin.
			const rejected = events.filter((event) => event.status === 401);
			expect(rejected, 'exactly one rejected reconnect').toHaveLength(1);
			await other.waitForTimeout(7_000);
			expect(events.filter((event) => event.at > rejected[0].at)).toEqual([]);
			expect(events.filter((event) => event.status === 401)).toHaveLength(1);
		} finally {
			await context.close();
		}
	});

	// Review of #242: two tabs of ONE browser share the "Remember me" token
	// (localStorage). The first tab's stream gets the `401`, confirms and
	// clears the shared token; the second tab's reconnect then finds no token
	// at all (no `401` of its own) and must still leave for /login. The second
	// tab's `/api/events` requests are aborted after the reset so it cannot
	// take the `401` path itself - only the "token disappeared" path.
	test('13c. a revoked Remember me session shared by two tabs sends both to the login page', async ({
		browser
	}) => {
		test.setTimeout(120_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const first = await context.newPage();
		const second = await context.newPage();
		try {
			const isEvents = (url: string) => new URL(url).pathname === '/api/events';
			const secondEventStatuses: number[] = [];
			second.on('response', (response) => {
				if (isEvents(response.url())) secondEventStatuses.push(response.status());
			});

			await first.goto('/login');
			await first.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await first.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await first.getByLabel('ログイン状態を保持する（30日間）').check();
			const firstStream = first.waitForResponse(
				(response) => isEvents(response.url()) && response.status() === 200
			);
			await first.getByRole('button', { name: 'ログイン' }).click();
			await expect(first).toHaveURL(/\/dashboard$/);
			await firstStream;

			const secondStream = second.waitForResponse(
				(response) => isEvents(response.url()) && response.status() === 200
			);
			await second.goto('/dashboard');
			await expect(second.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
			await secondStream;
			const shared = await first.evaluate(() => localStorage.getItem('banto.auth.token'));
			expect(shared, 'one shared Remember me token').toBeTruthy();
			expect(await second.evaluate(() => localStorage.getItem('banto.auth.token'))).toBe(shared);

			// From here on the second tab cannot reach the server's `401`.
			await second.route('**/api/events', (route) => route.abort());

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
					const viewer = rows.find((row) => row.username === username);
					if (!viewer) throw new Error('viewer account not found');
					const reset = await fetch(`/api/users/${viewer.id}/reset-password`, {
						method: 'POST',
						headers: { ...headers, 'Content-Type': 'application/json' },
						body: JSON.stringify({ newPassword: password })
					});
					if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
				},
				{ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }
			);

			await expect(first).toHaveURL(/\/login$/, { timeout: 40_000 });
			expect(
				await first.evaluate(() => localStorage.getItem('banto.auth.token')),
				'the first tab cleared the shared token'
			).toBeNull();
			// The second tab's stream ends at the server's next revalidation;
			// its reconnect finds the token gone.
			await expect(second).toHaveURL(/\/login$/, { timeout: 40_000 });
			expect(
				await second.evaluate(() => ({
					local: localStorage.getItem('banto.auth.token'),
					session: sessionStorage.getItem('banto.auth.token')
				}))
			).toEqual({ local: null, session: null });
			expect(secondEventStatuses, 'the second tab never got a 401 itself').not.toContain(401);
		} finally {
			await context.close();
		}
	});

	// Third review of #242: the revocation is confirmed while the FIRST
	// protected load is still waiting for its guard's check (judged valid by
	// the server, delivered late) - before the protected layout subscribes to
	// `onSessionEnded`. Once the held answer lets the route through and the
	// layout mounts, it must still leave for /login.
	test('13d. a revocation confirmed before the protected layout mounts still reaches it', async ({
		browser
	}) => {
		test.setTimeout(120_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		try {
			const isPath = (url: string, path: string) => new URL(url).pathname === path;
			await tab.goto('/login');
			await tab.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await tab.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await tab.getByLabel('ログイン状態を保持する（30日間）').check();
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);

			// Revocation seen by the stream, then its confirmation's check.
			const rejected = tab.waitForResponse(
				(response) => isPath(response.url(), '/api/events') && response.status() === 401,
				{ timeout: 60_000 }
			);
			let held = 0;
			let released!: () => void;
			const guardReleased = new Promise<void>((resolve) => (released = resolve));
			// Issue #260 実装-2: deterministic within the guard's 10 s deadline.
			// Every authorized stream request is held until the account is
			// revoked, then sent on - so the NEW document's stream gets its own
			// 401 right away instead of at the server's next revalidation (up to
			// 15 s later, past the guard's deadline: the retry page instead of
			// /login). Holding only the FIRST such request (the 実装-2 form)
			// assumed the dashboard document had already opened its stream when
			// this route was registered; when it had not (CI of #266 after
			// 73919f1, reproduced locally by registering the route before the
			// login), its request took the one hold and was dropped by the
			// navigation, and the new document's stream went through unheld.
			let revokedNow!: () => void;
			const revoked = new Promise<void>((resolve) => (revokedNow = resolve));
			await tab.route('**/api/events', async (route) => {
				if (!route.request().headers()['authorization']) return route.continue();
				await revoked;
				// The dashboard document's request may be gone with its navigation.
				await route.continue().catch(() => {});
			});
			// Issue #260 実装-2: the guard's session check is `/api/auth/identity`.
			await tab.route('**/api/auth/identity', async (route) => {
				// The confirmation's own check passes through; only the guard's
				// first check is held.
				if (held > 0 || !route.request().headers()['authorization']) return route.continue();
				held += 1;
				// The first guard's check of the next load: the server judges the
				// session valid now...
				const response = await route.fetch();
				expect(await response.json()).not.toBeNull();
				// ...then it is revoked, the stream gets its 401 and the
				// confirmation clears the token - all before this answer arrives.
				await page.evaluate(
					async ({ username, password }) => {
						const token =
							localStorage.getItem('banto.auth.token') ??
							sessionStorage.getItem('banto.auth.token');
						const headers = { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` };
						const list = await fetch('/api/users', { headers });
						const body = (await list.json()) as
							{ id: number; username: string }[] | { rows: { id: number; username: string }[] };
						const rows = Array.isArray(body) ? body : body.rows;
						const viewer = rows.find((row) => row.username === username);
						if (!viewer) throw new Error('viewer account not found');
						const reset = await fetch(`/api/users/${viewer.id}/reset-password`, {
							method: 'POST',
							headers: { ...headers, 'Content-Type': 'application/json' },
							body: JSON.stringify({ newPassword: password })
						});
						if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
					},
					{ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }
				);
				revokedNow();
				await rejected;
				await expect
					.poll(() => tab.evaluate(() => localStorage.getItem('banto.auth.token')), {
						timeout: 10_000
					})
					.toBeNull();
				// The confirmation's signal-caused check replaced the guard's
				// probe, and the SessionController aborted it (I-22), so this
				// request may be gone already - fulfilling it is best effort.
				await route.fulfill({ response }).catch(() => {});
				released();
			});

			// A fresh load of a protected screen: the guard waits on the held check.
			await tab.goto('/customers', { waitUntil: 'commit' });
			await guardReleased;
			// Issue #260 実装-2: the held (stale) `valid` answer is never applied.
			// The confirmation's signal-caused probe replaced the guard's probe
			// (I-9/I-22) and answered the guard too, so it goes straight to
			// /login - not through the retry page (all within its deadline).
			await expect(tab).toHaveURL(/\/login$/, { timeout: 10_000 });
			await expect(tab.getByRole('button', { name: '再試行' })).toHaveCount(0);
			expect(
				await tab.evaluate(() => ({
					local: localStorage.getItem('banto.auth.token'),
					session: sessionStorage.getItem('banto.auth.token')
				}))
			).toEqual({ local: null, session: null });
		} finally {
			await context.close();
		}
	});

	// Issue #260 (design §6.1, §8.4): the protected layout re-runs its load
	// whenever `snapshot.generation` differs from the generation that load
	// confirmed (wiring ①, since 実装-2), and reports a change of user the
	// controller recorded (wiring ②, 実装-3). These orders change the
	// generation without ever passing through `none`.
	async function loginRemembered(tab: Page, username: string, password: string): Promise<void> {
		await tab.goto('/login');
		await tab.getByLabel('ユーザー名').fill(username);
		await tab.getByLabel('パスワード').fill(password);
		await tab.getByLabel('ログイン状態を保持する（30日間）').check();
		await tab.getByRole('button', { name: 'ログイン' }).click();
		await expect(tab).toHaveURL(/\/dashboard$/);
	}

	// S-79: another tab logs in as a different user (the shared Remember me
	// token is replaced). This tab holds its session (unknown, g+1) on the
	// `storage` event, re-runs its load and confirms the new user (g+2) -
	// never passing through `none`. The page is rebuilt for the new user
	// instead of staying hidden behind the generation gate.
	test('13e. S-79: another tab’s login as a different user rebuilds this tab for that user', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(tab.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);

			// #258: a command palette left open by the previous user must not
			// outlive the switch (its query/selection/history are that user's).
			await tab.keyboard.press('Control+K');
			await expect(tab.getByRole('dialog', { name: 'コマンドパレット' })).toBeVisible();

			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);

			await expect(tab.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);
			await expect(tab.getByRole('dialog', { name: 'コマンドパレット' })).toHaveCount(0);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			// S-35 (wiring ②, 実装-3): the change of user is told once.
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(1);
			// This tab did not clear the shared token (I-17).
			expect(await tab.evaluate(() => localStorage.getItem('banto.auth.token'))).toBe(
				await other.evaluate(() => localStorage.getItem('banto.auth.token'))
			);
		} finally {
			await context.close();
		}
	});

	// S-80: another tab logs in again as the SAME user. The owner does not
	// change, but the hold and the re-confirmation move the generation by 2,
	// so the page is rebuilt (its in-memory state does not survive) - and is
	// shown again, not hidden.
	test('13f. S-80: another tab’s re-login as the same user rebuilds this tab’s page', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			const heading = tab.getByRole('heading', { name: 'ダッシュボード' });
			await expect(heading).toBeVisible();
			await heading.evaluate((element) => element.setAttribute('data-s80', 'before'));
			expect(await tab.locator('[data-s80]').count()).toBe(1);

			await loginRemembered(other, VIEWER_USERNAME, VIEWER_PASSWORD);

			await expect(tab.locator('[data-s80]')).toHaveCount(0);
			await expect(heading).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				VIEWER_DISPLAY_NAME
			);
			// S-59: the same user - no change-of-user notice.
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	/**
	 * The built client chunk (`_app/immutable/nodes/N.hash.js`) of one route file.
	 * Reads SvelteKit's build internals (layout as of SvelteKit 3: the node
	 * entries stay in `generated/build/client/nodes/`, the Vite manifest keys
	 * them as `generated/build/client-optimized/nodes/`); revisit on a kit
	 * upgrade if this throws.
	 */
	function nodeChunkOf(routeFile: string): string {
		const kit = new URL('../../apps/admin-template/.svelte-kit/', import.meta.url);
		const nodes = new URL('generated/build/client/nodes/', kit);
		const manifest = JSON.parse(
			fs.readFileSync(new URL('output/client/.vite/manifest.json', kit), 'utf8')
		) as Record<string, { file: string }>;
		for (const name of fs.readdirSync(nodes)) {
			if (!fs.readFileSync(new URL(name, nodes), 'utf8').includes(routeFile)) continue;
			const entry = manifest[`.svelte-kit/generated/build/client-optimized/nodes/${name}`];
			if (entry) return entry.file;
		}
		throw new Error(`no client chunk for ${routeFile} - run the admin-template build first`);
	}

	// S-74: the protected load confirmed the session (generation g), but the
	// page cannot mount yet (its client chunk is held). Meanwhile another tab
	// logs out - the shared token disappears - and this tab confirms `none`
	// (g+2) with nothing subscribed. When the layout finally mounts, wiring ①
	// sees g ≠ g+2 and re-runs the load, which sends the tab to /login: the
	// generation gate does not keep the screen hidden.
	test('13g. S-74: an ending confirmed before the protected layout mounts still sends it to /login', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await other.goto('/login');

			const chunk = nodeChunkOf('routes/(app)/dashboard/+page.svelte');
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let requested!: () => void;
			const chunkRequested = new Promise<void>((resolve) => (requested = resolve));
			await tab.route(`**/${chunk}`, async (route) => {
				requested();
				await released;
				await route.continue();
			});
			const sessionChecks: number[] = [];
			tab.on('response', (response) => {
				if (new URL(response.url()).pathname === '/api/auth/identity') {
					sessionChecks.push(response.status());
				}
			});

			await tab.goto('/dashboard', { waitUntil: 'commit' });
			await chunkRequested;
			// The guard confirmed the viewer (Issue #260 実装-3: one confirmation
			// per load - there is no separate `sessionStore.load()` any more).
			await expect.poll(() => sessionChecks.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
			expect(sessionChecks.every((status) => status === 200)).toBe(true);

			// Another tab logs out: the shared Remember me token disappears.
			await other.evaluate(() => localStorage.removeItem('banto.auth.token'));
			release();

			await expect(tab).toHaveURL(/\/login$/, { timeout: 20_000 });
		} finally {
			await context.close();
		}
	});

	/** Make this page's session checks fail (a 500) until `unroute`d. */
	async function failSessionChecks(tab: Page): Promise<() => Promise<void>> {
		const outage = async (route: Route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ kind: 'storage', message: 'database is locked' })
			});
		};
		await tab.route('**/api/auth/identity', outage);
		return () => tab.unroute('**/api/auth/identity', outage);
	}

	// S-36 / S-81 (Issue #260 実装-3, design §6.1 wiring ②③, I-24): another
	// tab logs in as a different user while this tab cannot confirm it (the
	// session check answers 500). This tab never shows the old user's screen:
	// its load ends on the retry page (503). The background confirmation later
	// confirms the new user - the retry page is NOT replaced on its own - and
	// the real "再試行" button (an in-document `refreshAll()` that keeps the
	// SessionController) rebuilds the screen for the new user and tells them
	// once: the change was recorded while no protected layout was mounted.
	test('13h. S-36/S-81: a switch that cannot be confirmed waits on the retry page; 再試行 opens the new user and tells them once', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

			const restore = await failSessionChecks(tab);
			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);

			// S-36: the retry page, on the same URL - not the viewer's screen, not /login.
			await expect(tab.getByText('ログイン状態を確認できませんでした')).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);

			// The server recovers; the background confirmation (backoff) confirms
			// the admin. The retry page stays until the user retries.
			const confirmed = tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/auth/identity' && response.status() === 200,
				{ timeout: 60_000 }
			);
			await restore();
			await confirmed;
			await expect(tab.getByText('ログイン状態を確認できませんでした')).toBeVisible();
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);

			// S-81: the real retry button.
			await tab.getByRole('button', { name: '再試行' }).click();
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);
			await expect(tab.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(1);
		} finally {
			await context.close();
		}
	});

	// S-83 (I-24): an unhandled change of user (A -> B, recorded while this tab
	// was on the retry page) is discarded when `none` is confirmed - here the
	// other tab logs out. The user goes home from the retry page, lands on
	// /login and signs in explicitly: no change-of-user notice for the old
	// A -> B, and the fresh login is not sent anywhere else.
	test('13i. S-83: a change of user left unhandled does not outlive a confirmed logout', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

			const restore = await failSessionChecks(tab);
			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);
			await expect(tab.getByText('ログイン状態を確認できませんでした')).toBeVisible();
			const confirmed = tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/auth/identity' && response.status() === 200,
				{ timeout: 60_000 }
			);
			await restore();
			await confirmed; // A -> B recorded, not handled (no protected layout)

			// The other tab logs out: the shared token disappears, this tab confirms `none`.
			await logout(other);
			await expect(other).toHaveURL(/\/login$/);

			await tab.getByRole('link', { name: 'トップへ戻る' }).click();
			await expect(tab).toHaveURL(/\/login$/);
			await tab.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await tab.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	// Issue #326: the generation moves WHILE a navigation is in flight - here
	// another tab logs in again (the shared Remember me token is replaced)
	// while this tab's move from the item form to the list is still loading
	// (the list's client chunk is held). Wiring ① must not start
	// `refreshAll()` in the middle of that navigation: SvelteKit 2.70
	// would abort it and leave its internal "navigating" flag set, after
	// which `beforeNavigate` - the unsaved-changes guard - is skipped. The
	// move completes, the re-run happens after it, and leaving a form with
	// unsaved input still asks.
	test('13j. #326: a generation change during a navigation keeps the move and the unsaved-changes guard', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		const dialogs = trackDialogs(tab);
		try {
			await loginRemembered(tab, ADMIN_USERNAME, ADMIN_PASSWORD);
			await tab.goto('/customers/new');
			await expect(tab.getByLabel('顧客名')).toBeVisible();

			const chunk = nodeChunkOf('routes/(app)/customers/+page.svelte');
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let requested!: () => void;
			const chunkRequested = new Promise<void>((resolve) => (requested = resolve));
			await tab.route(`**/${chunk}`, async (route) => {
				requested();
				await released;
				await route.continue();
			});

			// The form is clean: the move to the list starts without a prompt
			// and waits on the held chunk.
			await tab.getByRole('link', { name: '一覧へ戻る' }).click();
			await chunkRequested;

			// Another tab logs in again: this tab holds its session (the
			// generation moves) and confirms it again with the server.
			const reconfirmed = tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/auth/identity' && response.status() === 200
			);
			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);
			await reconfirmed;
			release();

			// The move completed (the re-run did not send the tab back to the
			// form) and the list is shown for the re-confirmed session.
			await expect(tab).toHaveURL(/\/customers$/);
			await expect(tab.getByRole('button', { name: '顧客を登録' })).toBeVisible();
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);

			// The unsaved-changes guard still runs: "stay" keeps the input.
			await tab.getByRole('button', { name: '顧客を登録' }).click();
			await expect(tab).toHaveURL(/\/customers\/new$/);
			const name = tab.getByLabel('顧客名');
			await expect(name).toBeVisible();
			await name.fill('E2E未保存-326');
			await expect(tab.getByText('未保存の変更があります')).toBeVisible();
			dialogs.answer(false);
			await tab
				.getByRole('navigation', { name: '主要ナビゲーション' })
				.getByRole('link', { name: 'ダッシュボード' })
				.click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(tab).toHaveURL(/\/customers\/new$/);
			await expect(name).toHaveValue('E2E未保存-326');
		} finally {
			dialogs.stop();
			await context.close();
		}
	});

	// nav-launcher-plan.md §3/§7.2: the dock is a per-user setting on the real
	// REST provider. Chosen in 外観, it navigates and survives a reload; a user
	// who never chose one gets the default sidebar on the same browser (the
	// localStorage cache is shared, the provider's "nothing stored" resets it);
	// the first user gets the dock back on their next login. Own context, and
	// the admin's setting is put back to the sidebar at the end so the shared
	// page of the scenarios below keeps the default.
	test('13k. dock layout: chosen per user, kept across a reload, not inherited by another user', async ({
		browser
	}) => {
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const layoutGroup = () => tab.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' });
		const savedLayout = () =>
			tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/ui-settings/shell.navLayout' &&
					response.request().method() === 'PUT'
			);
		try {
			await loginRemembered(tab, ADMIN_USERNAME, ADMIN_PASSWORD);
			await tab.goto('/settings');
			let saved = savedLayout();
			await layoutGroup().getByText('ドック', { exact: true }).click();
			expect((await saved).status()).toBe(204);
			await expect(tab.locator('.launcher')).toBeVisible();
			await expect(tab.locator('aside')).toHaveCount(0);
			await expect(tab.locator('html')).toHaveAttribute('data-banto-shell-nav', 'launcher');

			const nav = tab.getByRole('navigation', { name: '主要ナビゲーション' });
			await nav.getByRole('link', { name: '顧客' }).click();
			await expect(tab).toHaveURL(/\/customers$/);
			await expect(nav.getByRole('link', { name: '顧客' })).toHaveAttribute('aria-current', 'page');

			await tab.reload();
			await expect(tab.getByRole('grid')).toBeVisible();
			await expect(tab.locator('.launcher')).toBeVisible();

			// Another user on the same browser: nothing stored for them -> sidebar.
			await logout(tab);
			await expect(tab).toHaveURL(/\/login$/);
			await tab.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await tab.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.locator('aside')).toBeVisible();
			await expect(tab.locator('.launcher')).toHaveCount(0);
			await expect(tab.locator('html')).not.toHaveAttribute('data-banto-shell-nav', 'launcher');

			// The admin gets their own choice back, then restores the default.
			await logout(tab);
			await expect(tab).toHaveURL(/\/login$/);
			await tab.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await tab.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.locator('.launcher')).toBeVisible();

			await tab.goto('/settings');
			saved = savedLayout();
			await layoutGroup().getByText('サイドバー', { exact: true }).click();
			expect((await saved).status()).toBe(204);
			await expect(tab.locator('aside')).toBeVisible();
		} finally {
			await context.close();
		}
	});

	// Issue #432 PR-10 (shared-primitives-upstream-plan §3.5・D9): the dashboard
	// メモ pane keeps unapplied input while it is moved (the draft is owned by
	// the page, the pane is re-created on structure changes), a close settles it
	// (apply / discard / cancel), and leaving the page asks. The apply is held
	// open by routing the memo's ui-settings PUT, so input typed while it is in
	// flight must keep the pane open and dirty after v1 is saved.
	test('13l. dashboard memo: unapplied input survives a move; close settles it; leaving asks', async () => {
		test.setTimeout(90_000);
		const dialogs = trackDialogs(page);
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		const memoWindow = page.getByRole('dialog', { name: 'メモ' });
		const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
		const workspace = page.locator('.workspace');
		const unsaved = workspace.getByText('未保存の変更があります');
		const settleDialog = page.getByRole('dialog', { name: '保存していないメモ' });
		const memoToggle = workspace.getByRole('toolbar').getByRole('button', { name: /メモ/ });

		const memoPath = '/api/ui-settings/dashboard.memo';
		let releasePut: () => void = () => {};
		const putHeld = new Promise<void>((resolve) => (releasePut = resolve));
		const putBodies: string[] = [];
		const holdPut = async (route: Route) => {
			if (route.request().method() !== 'PUT') return route.continue();
			putBodies.push(route.request().postData() ?? '');
			await putHeld;
			await route.continue();
		};

		try {
			await page.goto('/dashboard');
			await workspace.getByRole('button', { name: 'リセット' }).click();
			await page.locator('.dock-wrapper').scrollIntoViewIfNeeded();
			await expect(memoWindow).toBeVisible();
			await expect(unsaved).toHaveCount(0);

			await memoInput.fill('unsaved');
			await expect(unsaved).toBeVisible();

			// Moving the window (geometry only, keyboard move mode) re-renders it
			// without losing the unapplied input. (banto-cost: the template also
			// docked / tabbed the memo into its chart panes, which were removed.)
			await memoWindow.getByRole('button', { name: /^メモをキーボードで移動/ }).focus();
			await page.keyboard.press('Enter');
			await page.keyboard.press('Shift+ArrowLeft', { delay: 20 });
			await page.keyboard.press('Enter');
			await expect(memoInput).toHaveValue('unsaved');
			await expect(unsaved).toBeVisible();

			// close -> apply, typing while the save is in flight: v1 is saved, the
			// pane stays open with the later input still unapplied.
			await page.route(`**${memoPath}`, holdPut);
			await memoWindow.getByRole('button', { name: 'メモを閉じる' }).click();
			await expect(settleDialog).toBeVisible();
			await settleDialog.getByRole('button', { name: '保存して閉じる' }).click();
			await expect(settleDialog).toHaveCount(0);
			await expect.poll(() => putBodies.length).toBe(1);
			await memoInput.fill('unsaved v2');
			const saved = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === memoPath && response.request().method() === 'PUT'
			);
			releasePut();
			expect((await saved).ok()).toBe(true);
			expect((JSON.parse(putBodies[0]!) as { value: string }).value).toBe('unsaved');
			await expect(
				workspace.getByText('保存中に入力した内容は、まだ保存されていません。')
			).toBeVisible();
			await expect(memoWindow).toBeVisible();
			await expect(memoInput).toHaveValue('unsaved v2');
			await expect(unsaved).toBeVisible();
			await page.unroute(`**${memoPath}`, holdPut);

			// close -> discard: closes, and the reopened memo shows what was saved.
			await memoWindow.getByRole('button', { name: 'メモを閉じる' }).click();
			await settleDialog.getByRole('button', { name: '破棄して閉じる' }).click();
			await expect(memoWindow).toHaveCount(0);
			await expect(memoToggle).toHaveAttribute('aria-pressed', 'false');
			await memoToggle.click();
			await expect(memoWindow).toBeVisible();
			await expect(memoInput).toHaveValue('unsaved');
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);

			// Leaving with unapplied input asks (the router guard): stay, then leave.
			await memoInput.fill('leave check');
			dialogs.answer(false);
			await mainNav.getByRole('link', { name: '顧客' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/dashboard$/);
			await expect(memoInput).toHaveValue('leave check');
			dialogs.answer(true);
			await mainNav.getByRole('link', { name: '顧客' }).click();
			await expect(page).toHaveURL(/\/customers$/);
			expect(dialogs.messages).toHaveLength(2);
		} finally {
			dialogs.stop();
			await page.unroute(`**${memoPath}`, holdPut);
			releasePut();
		}
	});

	// Issue #435 PR-11: Ctrl+S in the memo is the pane's save button as a
	// command of the app's shortcut dispatcher - taken inside the textarea, the
	// same serialized save. With nothing to save (or a held key) it is still
	// kept from the browser's "save page"; an IME composition is left alone.
	// Ctrl+K is taken in the textarea too, but not while another modal (the
	// memo's close prompt) is on screen.
	test('13m. dashboard memo: Ctrl+S saves from the textarea; Ctrl+K does not open over the close prompt', async () => {
		const memoWindow = page.getByRole('dialog', { name: 'メモ' });
		const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
		const workspace = page.locator('.workspace');
		const unsaved = workspace.getByText('未保存の変更があります');
		const settleDialog = page.getByRole('dialog', { name: '保存していないメモ' });
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		const memoPath = '/api/ui-settings/dashboard.memo';
		const putBodies: string[] = [];
		const recordPut = async (route: Route) => {
			if (route.request().method() === 'PUT') putBodies.push(route.request().postData() ?? '');
			await route.continue();
		};

		/** Dispatch a synthetic Ctrl+S keydown at the focused element; was it consumed? */
		const ctrlS = (init: { isComposing?: boolean; repeat?: boolean }) =>
			page.evaluate((extra) => {
				const event = new KeyboardEvent('keydown', {
					key: 's',
					code: 'KeyS',
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
					...extra
				});
				(document.activeElement ?? document.body).dispatchEvent(event);
				return event.defaultPrevented;
			}, init);

		try {
			await page.route(`**${memoPath}`, recordPut);
			await page.goto('/dashboard');
			await workspace.getByRole('button', { name: 'リセット' }).click();
			await page.locator('.dock-wrapper').scrollIntoViewIfNeeded();
			await expect(memoWindow).toBeVisible();
			await memoInput.fill('saved with ctrl+s');
			await expect(unsaved).toBeVisible();

			// Composing: not taken, nothing saved.
			await memoInput.focus();
			expect(await ctrlS({ isComposing: true })).toBe(false);
			await expect(unsaved).toBeVisible();
			expect(putBodies).toHaveLength(0);

			// Ctrl+S in the textarea saves; the unsaved notice goes away.
			const saved = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === memoPath && response.request().method() === 'PUT'
			);
			await memoInput.press('Control+S');
			expect((await saved).ok()).toBe(true);
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);
			expect((JSON.parse(putBodies[0]!) as { value: string }).value).toBe('saved with ctrl+s');

			// Nothing to save, and a held key: consumed, nothing sent.
			expect(await ctrlS({})).toBe(true);
			expect(await ctrlS({ repeat: true })).toBe(true);
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);

			// Ctrl+K from the textarea opens and closes the palette.
			await memoInput.focus();
			await page.keyboard.press('Control+K');
			await expect(palette).toBeVisible();
			await page.keyboard.press('Control+K');
			await expect(palette).toHaveCount(0);

			// Another modal on screen (the close prompt): Ctrl+K does not open the palette.
			await memoInput.fill('typed again');
			await memoWindow.getByRole('button', { name: 'メモを閉じる' }).click();
			await expect(settleDialog).toBeVisible();
			await page.keyboard.press('Control+K');
			await expect(palette).toHaveCount(0);
			await settleDialog.getByRole('button', { name: 'キャンセル' }).click();
			await expect(settleDialog).toHaveCount(0);

			// Leave clean for the next test (back to the stored text).
			await memoInput.fill('saved with ctrl+s');
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);
		} finally {
			await page.unroute(`**${memoPath}`, recordPut);
		}
	});

	// PR-B3 (i18n layer ②, ADR-0005): the settings
	// language picker actually switches the whole UI locale. Deliberately LAST:
	// Paraglide's setLocale() persists the choice to this shared page's
	// localStorage and reloads every screen, so switching to English here can't
	// disturb the Japanese-asserting scenarios above (which run first).
	test('14. settings: the language picker switches the whole UI to English', async () => {
		await page.goto('/settings');

		// The <select> is still labelled in Japanese (表示言語) at this point. Its
		// option labels (日本語 / English) are intentionally NOT translated, so
		// switch by value. selectOption fires the change handler -> setLocale('en')
		// -> a full reload into English (Paraglide's default).
		const languageSelect = page.getByLabel('表示言語');
		await expect(languageSelect).toBeVisible();
		await languageSelect.selectOption('en');

		// After the reload the page renders in English: the page header
		// (nav.settings) and the language card heading (settings.languageHeading)
		// both flip. Asserting a keyed string proves the switch reached the UI,
		// not just localStorage.
		await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Language', exact: true })).toBeVisible();
	});
});
