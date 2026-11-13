/**
 * The main business flow on one fictional project (review
 * design-ux-data-review-2026-11 §8-11, U-7 / D-8, P8g), against the same
 * `banto-serve` + SQLite as smoke.spec.ts:
 *
 *   案件登録 → 案件見込を採用 → 受注転換 → 状態を進行中へ → 工数「申請して承認」
 *   → 直接費の申請 → 承認一覧で一括承認 → 売上計上 → 完了見込（赤字）
 *   → ダッシュボードの「確認すること」
 *
 * Each step goes through the screen a person uses (labels, the confirmation
 * Modal of P8f), and checks the figures the next screen shows - the server
 * rules themselves are tested in cost-domain and core/src/rest/tests.rs. The
 * calc basis rate (a project override) and the completion forecast go
 * through the REST API: they are set-up for the figures, not the flow under test.
 * Then every business screen visited is scanned with axe (wcag2a/wcag2aa),
 * which the visual project cannot do (it runs in browser demo mode, without
 * the cost API).
 *
 * Runs in its own page, after smoke.spec.ts (file order, one worker): it logs
 * in as smoke's administrator - or creates that account when this file runs
 * alone - and gives it Japanese and every capability again (smoke 14 saves
 * English, 3g narrows the capabilities). All
 * names are fictional and carry the run's timestamp.
 */
import AxeBuilder from '@axe-core/playwright';
import {
	expect,
	test,
	type BrowserContext,
	type Locator,
	type Page,
	type Route
} from '@playwright/test';

// Same administrator as smoke.spec.ts (first-run setup there).
const ADMIN_USERNAME = 'public';
const ADMIN_PASSWORD = 'E2eAdminPass1';
const ADMIN_DISPLAY_NAME = 'E2E管理者';

const RUN = Date.now();
const CUSTOMER = `E2E架空精機-${RUN}`;
const PROJECT_CODE = `WF-${RUN}`;
const PROJECT_NAME = 'E2E架空の検査装置';
const PROJECT_LABEL = `${PROJECT_CODE} ${PROJECT_NAME}`;
// Row texts carry the run too: a CI retry reruns the group on the same server.
const WORK_NOTE = `E2E架空の図面作成-${RUN}`;
const COST_NOTE = `E2E架空の部材-${RUN}`;

const ALL_CAPABILITIES = [
	'time.entry',
	'pipeline.edit',
	'project.manage',
	'finance.rate',
	'finance.close',
	'report.all',
	'amount.view'
];

/** Call the REST API with the page's session (same as smoke.spec.ts). */
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

/** Answer the confirmation Modal (confirmAction, P8f) with its action button. */
async function confirmModal(page: Page, title: string, action: string): Promise<void> {
	const dialog = page.getByRole('dialog', { name: title });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: action, exact: true }).click();
	await expect(dialog).toBeHidden();
}

function region(page: Page, name: string): Locator {
	return page.getByRole('region', { name, exact: true });
}

/**
 * What the dashboard's 確認すること should count right now, read from the same
 * APIs: the database is shared with smoke.spec.ts and a CI retry reruns this
 * group on the same server, so the tests compare with these, never with a
 * fixed number.
 */
async function expectedCounts(page: Page, month: string, previous: string) {
	const portfolio = await api<{ totals: { alertCounts: { alert: string; count: number }[] } }>(
		page,
		'GET',
		'/api/portfolio'
	);
	const lengths = await Promise.all(
		[
			'/api/time-entries/approvals',
			'/api/direct-costs/approvals',
			'/api/time-entries/corrections'
		].map((path) => api<unknown[]>(page, 'GET', path).then((rows) => rows.length))
	);
	const due = (path: string) =>
		api<{ dueCount: number }>(page, 'GET', path).then((v) => v.dueCount);
	return {
		forecastLoss: portfolio.totals.alertCounts.find((a) => a.alert === 'forecast_loss')?.count ?? 0,
		/** Time entries, direct costs, corrections. */
		approvalLists: lengths,
		approvals: lengths.reduce((a, b) => a + b, 0),
		fixedDue: await due(`/api/fixed-costs/months/${month}`),
		recurringDue: await due(`/api/recurring-revenue/months/${month}`),
		recurringPrevious: await due(`/api/recurring-revenue/months/${previous}`)
	};
}

const counted = (n: number) => `${n} 件`;

function previousOf(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** A dashboard tile's figure. */
function tile(page: Page, id: string): Locator {
	return page.locator(`[data-tile="${id}"] .stat-value`);
}

test.describe.serial('banto-cost business flow on one fictional project', () => {
	let context: BrowserContext;
	let page: Page;
	let today: string;
	let month: string;
	let projectId: number;

	test.beforeAll(async ({ browser }) => {
		// A context of its own (not browser.newPage): AxeBuilder needs one.
		context = await browser.newContext({ reducedMotion: 'reduce' });
		page = await context.newPage();
		await page.goto('/login');
		await expect(page.getByRole('heading', { name: 'Banto Cost' })).toBeVisible();
		const setup = page.getByLabel('表示名');
		const login = page.getByRole('button', { name: 'ログイン' });
		await expect(setup.or(login)).toBeVisible();
		if (await setup.isVisible()) {
			await setup.fill(ADMIN_DISPLAY_NAME);
			await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
			await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
			await page.getByRole('button', { name: 'アカウントを作成' }).click();
		} else {
			await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await login.click();
		}
		await expect(page).toHaveURL(/\/dashboard$/);
		// Smoke 14 saves English for this account; the flow reads the Japanese labels.
		await api(page, 'PUT', '/api/ui-settings/ui.locale', { value: 'ja' });
		await page.evaluate(() => localStorage.setItem('banto.locale', 'ja'));
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

		const users = await api<{ id: number; username: string }[]>(page, 'GET', '/api/users');
		const admin = users.find((user) => user.username === ADMIN_USERNAME)!;
		await api(page, 'PUT', `/api/users/${admin.id}/capabilities`, {
			capabilities: ALL_CAPABILITIES
		});
		await api(page, 'POST', '/api/customers', { name: CUSTOMER });
		// The business date (Asia/Tokyo), not the runner's clock.
		today = (await api<{ today: string }>(page, 'GET', '/api/calendar')).today;
		month = today.slice(0, 7);
	});

	test.afterAll(async () => {
		await context?.close();
	});

	test('1. 案件登録: the new project opens on its detail page', async () => {
		await page.goto('/projects/new');
		await page.getByRole('textbox', { name: '案件ID' }).fill(PROJECT_CODE);
		await page.getByRole('textbox', { name: '案件名' }).fill(PROJECT_NAME);
		await page.getByRole('combobox', { name: /顧客/ }).selectOption({ label: CUSTOMER });
		await page
			.getByRole('combobox', { name: /責任者/ })
			.selectOption({ label: ADMIN_DISPLAY_NAME });
		await page.getByRole('combobox', { name: /状態/ }).selectOption({ label: '見積中' });
		await page.getByRole('button', { name: '保存', exact: true }).click();

		// P8a §8-2: a new project goes to its own page, not back to the list.
		await expect(page).toHaveURL(/\/projects\/\d+$/);
		await expect(page.getByRole('heading', { name: '案件の詳細' })).toBeVisible();
		projectId = Number(new URL(page.url()).pathname.split('/').pop());
		await expect(region(page, '利益の要約')).toContainText('受注前の案件です');
	});

	test('2. 案件見込: an adopted version with a revenue plan', async () => {
		const pipeline = region(page, '案件見込');
		await pipeline.getByRole('combobox', { name: '営業段階' }).selectOption({ label: '内示あり' });
		await pipeline.getByRole('textbox', { name: '見込受注額（円）' }).fill('3000000');
		await pipeline.getByRole('textbox', { name: '受注確度（%）' }).fill('80');
		await pipeline.getByRole('textbox', { name: '受注予定月' }).fill(month);
		await pipeline.getByRole('textbox', { name: '根拠（変更理由）' }).fill('架空の見積書を提出');
		await pipeline.getByRole('button', { name: '行を追加' }).click();
		const plan = pipeline.getByRole('group', { name: '売上計上予定' });
		await plan.getByRole('textbox', { name: '売上予定月' }).fill(month);
		await plan.getByRole('textbox', { name: '金額（円）' }).fill('3000000');
		await pipeline.getByRole('button', { name: '採用して保存' }).click();

		const history = pipeline.getByRole('table', { name: '版の履歴' });
		await expect(
			history.getByRole('row', { name: /第1版 採用版 内示あり ¥3,000,000 80%/ })
		).toBeVisible();
	});

	test('3. 受注転換: the confirmation names the project and amount, then the order is recorded', async () => {
		const orders = region(page, '受注・売上');
		await orders.getByRole('button', { name: '受注転換' }).click();
		await orders.getByRole('textbox', { name: '確定受注額（円・税抜）' }).fill('3000000');
		await orders.getByRole('textbox', { name: '予定開始日' }).fill(`${month}-01`);
		await orders.getByRole('textbox', { name: '予定完了日' }).fill(today);
		await orders.getByRole('textbox', { name: '根拠' }).fill('架空の注文書を受領');
		const plan = orders.getByRole('group', { name: '受注済みの売上予定' });
		await plan.getByRole('textbox', { name: '売上予定月' }).fill(month);
		await plan.getByRole('textbox', { name: '金額（円）' }).fill('3000000');
		await orders.getByRole('button', { name: '受注転換する' }).click();

		const dialog = page.getByRole('dialog', { name: '受注転換' });
		await expect(dialog).toContainText(PROJECT_CODE);
		await expect(dialog).toContainText('¥3,000,000');
		await confirmModal(page, '受注転換', '受注転換する');

		await expect(region(page, '受注・売上の集計')).toContainText('確定受注額 ¥3,000,000');
		await expect(region(page, '受注・売上の集計')).toContainText('未計上残 ¥3,000,000');
		await expect(region(page, '利益の要約')).toContainText('確定受注額 ¥3,000,000');
	});

	test('4. 状態を進行中へ: saving stays on the detail page', async () => {
		// The labor rate of this project only (calc basis override, design 第10章).
		await api(page, 'POST', `/api/projects/${projectId}/calc-basis`, {
			itemKey: 'emp_rate',
			validFrom: `${month}-01`,
			value: 5000,
			reason: 'E2E架空の単価'
		});
		await page.getByRole('combobox', { name: /状態/ }).selectOption({ label: '進行中' });
		await page.getByRole('button', { name: '保存', exact: true }).first().click();
		await expect(page.locator('main dl').first()).toContainText('進行中');
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
	});

	test('5. 工数: a draft, then 申請して承認 with its confirmation', async () => {
		await page.goto('/time');
		await page.getByRole('button', { name: '工数を追加', exact: true }).click();
		const form = page.getByRole('form', { name: '工数を追加' });
		await expect(form.getByRole('textbox', { name: '作業日' })).toHaveValue(today);
		await form.getByRole('combobox', { name: '案件' }).selectOption({ label: PROJECT_LABEL });
		await form.getByRole('combobox', { name: '工程' }).selectOption({ label: '設計' });
		await form.getByRole('spinbutton', { name: '時間' }).fill('3');
		await form.getByRole('textbox', { name: '作業内容' }).fill(WORK_NOTE);
		await form.getByRole('button', { name: '下書きとして保存' }).click();

		const row = page.getByRole('row', { name: new RegExp(WORK_NOTE) });
		await expect(row).toContainText('下書き');
		await row.getByRole('button', { name: '申請して承認', exact: true }).click();
		await expect(page.getByRole('dialog', { name: '申請して承認' })).toContainText(PROJECT_CODE);
		await confirmModal(page, '申請して承認', '申請して承認');
		await expect(row).toContainText('承認済み');
	});

	test('6. 直接費: a draft submitted for the month waits on the dashboard and the approvals list', async () => {
		await page.goto('/costs');
		await page.getByRole('button', { name: '直接費を追加', exact: true }).click();
		const form = page.getByRole('form', { name: '直接費を追加' });
		await form.getByRole('combobox', { name: '案件' }).selectOption({ label: PROJECT_LABEL });
		await form.getByRole('combobox', { name: '費目' }).selectOption({ label: '材料費' });
		await form.getByRole('textbox', { name: '金額（税抜・円）' }).fill('120000');
		await form.getByRole('textbox', { name: '内容' }).fill(COST_NOTE);
		await form.getByRole('button', { name: '下書きとして保存' }).click();
		const row = page.getByRole('row', { name: new RegExp(COST_NOTE) });
		await expect(row).toContainText('下書き');
		const before = await expectedCounts(page, month, previousOf(month));
		await page.getByRole('button', { name: /この月の下書きを申請/ }).click();
		await expect(row).toContainText('申請中');

		// P8g §8-10: the dashboard counts it, and the tile leads to the list.
		await page.goto('/dashboard');
		await expect(tile(page, 'approvals')).toHaveText(counted(before.approvals + 1));
		await page.locator('[data-tile="approvals"]').click();
		await expect(page).toHaveURL(/\/approvals$/);
	});

	test('7. 承認一覧: 表示中をすべて承認 with its confirmation', async () => {
		const costs = region(page, '直接費の承認');
		await expect(costs.getByRole('row', { name: new RegExp(COST_NOTE) })).toBeVisible();
		const approveAll = costs.getByRole('button', { name: /^表示中をすべて承認（\d+件）$/ });
		const label = (await approveAll.textContent())!.trim();
		await approveAll.click();
		await confirmModal(page, '直接費の一括承認', label);
		await expect(costs).toContainText('承認待ちの直接費はありません');
	});

	test('8. 売上計上: the plan is cleared and the summary shows the actual cost', async () => {
		await page.goto(`/projects/${projectId}`);
		const orders = region(page, '受注・売上');
		await orders.getByRole('textbox', { name: '計上日' }).fill(today);
		await orders.getByRole('textbox', { name: '計上額（円・税抜）' }).fill('3000000');
		await orders.getByRole('textbox', { name: '根拠' }).last().fill('E2E架空の検収書');
		await orders.getByRole('button', { name: '売上を計上' }).click();

		const totals = region(page, '受注・売上の集計');
		await expect(totals).toContainText('計上済み売上 ¥3,000,000');
		await expect(totals).toContainText('未計上残 ¥0');
		// 3:00 × ¥5,000 (labor) + ¥120,000 (material), both approved.
		await expect(region(page, '工数')).toContainText('労務原価 ¥15,000');
		await expect(region(page, '利益の要約')).toContainText('最新実績（承認済み） ¥135,000');
		await expect(region(page, '利益の要約')).toContainText('完了見込なし');
	});

	test('9. ダッシュボード: a loss forecast shows under 確認すること and leads to the overall list', async () => {
		const before = await expectedCounts(page, month, previousOf(month));
		// The completion forecast is set-up here (its screen is not the flow
		// under test): ¥3,500,000 still to come on a ¥3,000,000 order.
		const { draft } = await api<{ draft: { id: number; baseDate: string; rowVersion: number } }>(
			page,
			'POST',
			`/api/projects/${projectId}/forecast/draft`,
			{}
		);
		const saved = await api<{ rowVersion: number }>(
			page,
			'PUT',
			`/api/forecast-versions/${draft.id}`,
			{
				baseDate: draft.baseDate,
				plannedEnd: null,
				reason: 'E2E架空の追加外注',
				lines: [
					{ phaseId: null, costType: 'outsource', remainingMinutes: null, amount: 3_500_000 }
				],
				rowVersion: draft.rowVersion
			}
		);
		await api(page, 'POST', `/api/forecast-versions/${draft.id}/adopt`, {
			rowVersion: saved.rowVersion
		});

		const now = await expectedCounts(page, month, previousOf(month));
		expect(now.forecastLoss).toBe(before.forecastLoss + 1);

		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: '確認すること' })).toBeVisible();
		await expect(tile(page, 'forecast-loss')).toHaveText(counted(now.forecastLoss));
		await expect(page.locator('[data-tile="forecast-loss"]')).toHaveClass(/check-active/);
		await expect(tile(page, 'approvals')).toHaveText(counted(now.approvals));
		await expect(tile(page, 'fixed-costs-due')).toHaveText(counted(now.fixedDue));
		await expect(tile(page, 'recurring-revenue-due')).toHaveText(counted(now.recurringDue));

		await page.locator('[data-tile="forecast-loss"]').click();
		await expect(page).toHaveURL(/\/projects$/);
		await expect(page.getByText(PROJECT_NAME).first()).toBeVisible();
	});

	test('9b. ダッシュボード: each source shows when it answers; a failed or slow part only marks its note', async () => {
		const previous = previousOf(month);
		const now = await expectedCounts(page, month, previous);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const hold = async (route: Route) => {
			await held;
			await route.continue();
		};
		// Still on its way: the overall list, and the previous month of 定期売上.
		await page.route('**/api/portfolio', hold);
		await page.route(`**/api/recurring-revenue/months/${previous}`, hold);
		// Failed: the previous month of 月額固定, and one of the three approval lists.
		await page.route(`**/api/fixed-costs/months/${previous}`, (route) =>
			route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
		);
		await page.route('**/api/direct-costs/approvals', (route) =>
			route.fulfill({
				status: 403,
				contentType: 'application/json',
				body: JSON.stringify({ code: 'forbidden', message: 'forbidden' })
			})
		);
		const note = (id: string) => page.locator(`[data-tile="${id}"] .stat-note`);
		try {
			await page.goto('/dashboard');
			// The tiles already read do not wait for the slow ones.
			await expect(tile(page, 'forecast-loss')).toHaveText('読み込み中…');
			await expect(tile(page, 'recurring-revenue-due')).toHaveText(counted(now.recurringDue));
			await expect(note('recurring-revenue-due')).toContainText(`前月（${previous}）を確認中`);
			// This month's count stays; only the note says the previous month failed.
			await expect(tile(page, 'fixed-costs-due')).toHaveText(counted(now.fixedDue));
			await expect(note('fixed-costs-due')).toContainText(
				`前月（${previous}）の件数は取得できません`
			);
			// The readable approval lists are counted, and the tile says a part is missing.
			const [time, , corrections] = now.approvalLists;
			await expect(tile(page, 'approvals')).toHaveText(counted(time + corrections));
			await expect(note('approvals')).toContainText('一部の一覧を取得できない');
			release();
			await expect(tile(page, 'forecast-loss')).toHaveText(counted(now.forecastLoss));
			await expect(note('recurring-revenue-due')).toContainText(
				`前月（${previous}）の未計上 ${now.recurringPrevious} 件`
			);
		} finally {
			release();
			await page.unrouteAll({ behavior: 'wait' });
		}
	});

	// D-8: the business screens of the flow, with its data on them. The
	// template's own screens are scanned by the visual project (a11y.spec.ts).
	const SCREENS: { path: () => string; heading: string }[] = [
		{ path: () => '/dashboard', heading: 'ダッシュボード' },
		{ path: () => '/projects', heading: '案件台帳' },
		{ path: () => `/projects/${projectId}`, heading: '案件の詳細' },
		{ path: () => '/pipeline', heading: '案件見込' },
		{ path: () => '/outlook', heading: '月次見通し' },
		{ path: () => '/time', heading: '工数入力' },
		{ path: () => '/costs', heading: '直接費入力' },
		{ path: () => '/approvals', heading: '承認一覧' },
		{ path: () => '/fixed-costs', heading: '月額固定原価' },
		{ path: () => '/recurring-revenue', heading: '定期売上' },
		{ path: () => '/closing', heading: '月次締め' },
		{ path: () => '/calc-basis', heading: '計算基準' },
		{ path: () => '/work-masters', heading: '工程・共通活動・取引先' }
	];

	test('10. axe: the business screens have no wcag2a/wcag2aa violations in either theme', async () => {
		const failures: string[] = [];
		// Contrast differs per theme, so pin each one in turn: the user's saved
		// mode (smoke 10 pins dark for this account) and the local first-paint
		// cache both, so neither wins over the other on the next load.
		for (const theme of ['light', 'dark', 'system'] as const) {
			await api(page, 'PUT', '/api/ui-settings/theme.mode', { value: theme });
			await page.evaluate((mode) => localStorage.setItem('banto.theme', mode), theme);
			if (theme === 'system') break;
			for (const screen of SCREENS) {
				await scan(screen, theme);
			}
		}
		expect(failures, failures.join('\n\n')).toEqual([]);

		async function scan(screen: (typeof SCREENS)[number], theme: string): Promise<void> {
			await page.goto(screen.path());
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await expect(
				page.getByRole('heading', { name: screen.heading, level: 1, exact: true })
			).toBeVisible();
			// Every screen shows its data or its empty state after the load; the
			// loading text must be gone before the scan.
			await expect(page.locator('main')).not.toContainText('読み込み中');
			const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
			for (const v of results.violations) {
				const nodes = v.nodes.map((n) => `    - ${n.target.join(' ')}`).join('\n');
				failures.push(
					`${theme} ${screen.path()} [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n${nodes}`
				);
			}
		}
	});
});
