// README（取扱説明書）の画面画像を撮り直す。
//
// 空の SQLite で初回設定を有効にした banto-serve（embed-ui 付き）に対して、
// 架空のサンプルデータを REST で登録し、各画面を Playwright で撮影して
// docs/assets/manual/ に保存する。手順は docs/assets/manual/README.md。
//
// 実データを使わないこと（CLAUDE.md）。ここに書く会社名・人名・金額はすべて架空。
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8811';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/assets/manual');
const USERNAME = 'admin';
const PASSWORD = 'DemoPass123';

let token;
async function api(method, url, body) {
	const headers = { 'X-Banto-Client': 'banto' };
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	const res = await fetch(BASE + url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

async function seed() {
	const setup = await api('POST', '/api/auth/setup', {
		username: USERNAME,
		password: PASSWORD,
		displayName: '山田 太郎'
	});
	token = setup.token;
	await api('PUT', '/api/users/1/capabilities', {
		capabilities: [
			'time.entry',
			'pipeline.edit',
			'project.manage',
			'finance.rate',
			'finance.close',
			'report.all',
			'amount.view'
		]
	});

	for (const [itemKey, value, reason] of [
		['emp_rate', 4_500, '第13期の標準'],
		['forecast_rate', 5_000, '標準'],
		['budget_rate', 5_000, '標準'],
		['target_margin_pct', 15, '第13期の目標']
	]) {
		await api('POST', '/api/calc-basis', { itemKey, validFrom: '2026-06-01', value, reason });
	}

	const customer = {};
	for (const name of ['架空工業株式会社', '見本電機株式会社', '試作化学株式会社']) {
		customer[name] = (await api('POST', '/api/customers', { name, active: true })).id;
	}
	const vendor = (await api('POST', '/api/vendors', { name: '架空技研' })).id;

	const project = (code, name, customerName, status) =>
		api('POST', '/api/projects', {
			code,
			name,
			customerId: customer[customerName],
			managerUserId: 1,
			status
		});
	const a = await project('J-1301', '第2工場 制御盤更新', '架空工業株式会社', 'negotiating');
	const b = await project('J-1302', '生産管理ソフト改修', '見本電機株式会社', 'negotiating');
	const c = await project('J-1303', '新ライン立上げ 制御設計', '試作化学株式会社', 'negotiating');
	const d = await project('J-1304', '受入設備 自動化検討', '架空工業株式会社', 'lead');
	const e = await project('J-1305', '監視システム 年間保守', '見本電機株式会社', 'negotiating');

	const pipeline = (p, body) =>
		api('POST', `/api/projects/${p.id}/pipeline-versions`, { ...body, adopt: true });
	await pipeline(a, {
		stage: 'negotiating',
		expectedAmount: 6_000_000,
		probabilityPct: 80,
		expectedOrderMonth: '2026-07',
		basis: '見積提出済み',
		revenuePlan: [{ month: '2027-02', amount: 6_000_000 }]
	});
	await pipeline(b, {
		stage: 'negotiating',
		expectedAmount: 2_500_000,
		probabilityPct: 70,
		expectedOrderMonth: '2026-08',
		basis: '仕様打合せ済み',
		revenuePlan: [{ month: '2026-12', amount: 2_500_000 }]
	});
	await pipeline(c, {
		stage: 'negotiating',
		expectedAmount: 8_000_000,
		probabilityPct: 60,
		expectedOrderMonth: '2026-12',
		basis: '見積提出済み・競合あり',
		revenuePlan: [
			{ month: '2027-03', amount: 4_000_000 },
			{ month: '2027-05', amount: 4_000_000 }
		]
	});
	await pipeline(d, {
		stage: 'lead',
		expectedAmount: 1_500_000,
		probabilityPct: 30,
		expectedOrderMonth: '2027-01',
		basis: '引合を受けた',
		revenuePlan: [{ month: '2027-04', amount: 1_500_000 }]
	});

	const convert = async (p, body) => {
		const current = await api('GET', `/api/projects/${p.id}`);
		return api('POST', `/api/projects/${p.id}/order/convert`, {
			rowVersion: current.rowVersion,
			scope: 'whole',
			...body
		});
	};
	await convert(a, {
		convertedOn: '2026-07-15',
		confirmedAmount: 6_200_000,
		basis: '注文書受領',
		plannedStart: '2026-08-01',
		plannedEnd: '2027-02-28',
		revenuePlan: [
			{ month: '2026-10', amount: 2_000_000 },
			{ month: '2027-02', amount: 4_200_000 }
		]
	});
	await convert(b, {
		convertedOn: '2026-08-20',
		confirmedAmount: 2_400_000,
		basis: '注文書受領',
		plannedStart: '2026-09-01',
		plannedEnd: '2026-12-25',
		revenuePlan: [{ month: '2026-12', amount: 2_400_000 }]
	});
	await convert(e, {
		convertedOn: '2026-06-01',
		confirmedAmount: 3_600_000,
		basis: '年間保守契約',
		plannedStart: '2026-06-01',
		plannedEnd: '2027-05-31',
		revenuePlan: [{ month: null, amount: 3_600_000 }]
	});

	const change = await api('POST', `/api/projects/${a.id}/order/changes`, {
		deltaAmount: 300_000,
		planMonth: '2027-02',
		basis: '追加画面2枚'
	});
	await api('POST', `/api/projects/${a.id}/order/changes/${change.changes[0].id}/decide`, {
		approve: true
	});
	await api('POST', `/api/projects/${a.id}/order/recognitions`, {
		recognizedOn: '2026-10-30',
		amount: 2_000_000
	});
	await api('POST', '/api/recurring-revenue/agreements', {
		projectId: e.id,
		monthlyAmount: 300_000,
		fromMonth: '2026-06',
		toMonth: '2027-05'
	});
	for (const month of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
		await api('POST', `/api/recurring-revenue/months/${month}/recognize`, {});
	}

	const budget = async (p, lines) => {
		const { draft } = await api('POST', `/api/projects/${p.id}/budget/draft`, {});
		const saved = await api('PUT', `/api/budget-versions/${draft.id}`, {
			rowVersion: draft.rowVersion,
			lines
		});
		await api('POST', `/api/budget-versions/${draft.id}/approve`, {
			rowVersion: saved.rowVersion
		});
	};
	await budget(a, [
		{ phaseId: 1, costType: 'labor', plannedMinutes: 9_000 },
		{ phaseId: 3, costType: 'labor', plannedMinutes: 6_000 },
		{ phaseId: 5, costType: 'labor', plannedMinutes: 4_800 },
		{ costType: 'material', amount: 1_800_000 },
		{ costType: 'outsource', amount: 600_000 },
		{ costType: 'travel', amount: 200_000 }
	]);
	await budget(b, [
		{ phaseId: 2, costType: 'labor', plannedMinutes: 12_000 },
		{ phaseId: 4, costType: 'labor', plannedMinutes: 2_400 },
		{ costType: 'outsource', amount: 300_000 }
	]);

	let request = 0;
	const time = async (p, workDate, phaseId, minutes, description, approve = true) => {
		const { entry } = await api('POST', '/api/time-entries', {
			workDate,
			projectId: p.id,
			phaseId,
			minutes,
			description,
			clientRequestId: `manual-${request++}`
		});
		const submitted = await api('POST', `/api/time-entries/${entry.id}/submit`, {
			rowVersion: entry.rowVersion
		});
		if (approve) {
			await api('POST', `/api/time-entries/${entry.id}/decide`, {
				rowVersion: submitted.rowVersion,
				approve: true
			});
		}
	};
	for (const [day, phase, minutes, text] of [
		['2026-08-05', 1, 420, '盤図の作成'],
		['2026-08-06', 1, 480, '盤図の作成'],
		['2026-09-10', 3, 480, '盤組立'],
		['2026-09-11', 3, 450, '盤組立'],
		['2026-10-14', 4, 360, '工場試験'],
		['2026-11-04', 5, 480, '現地据付・調整'],
		['2026-11-05', 5, 480, '現地調整']
	]) {
		await time(a, day, phase, minutes, text);
	}
	for (const [day, phase, minutes, text] of [
		['2026-09-02', 2, 480, '画面の改修'],
		['2026-09-03', 2, 480, '帳票の改修'],
		['2026-10-07', 2, 420, 'データ移行処理'],
		['2026-11-09', 4, 360, '結合試験']
	]) {
		await time(b, day, phase, minutes, text);
	}
	await time(a, '2026-11-10', 5, 240, '現地調整（残作業）', false);
	await time(b, '2026-11-11', 4, 300, '受入試験の準備', false);

	const cost = async (key, body) => {
		const { cost: created } = await api('POST', '/api/direct-costs', {
			...body,
			clientRequestId: `manual-${key}`
		});
		const response = await api('POST', `/api/direct-costs/${created.id}/submit`, {
			rowVersion: created.rowVersion
		});
		const submitted = response.cost ?? response;
		await api('POST', `/api/direct-costs/${created.id}/decide`, {
			rowVersion: submitted.rowVersion,
			approve: true
		});
	};
	const { order } = await api('POST', '/api/purchase-orders', {
		projectId: a.id,
		costType: 'outsource',
		vendorId: vendor,
		orderedOn: '2026-08-10',
		amount: 600_000,
		clientRequestId: 'manual-po'
	});
	await cost('a-mat1', {
		projectId: a.id,
		costType: 'material',
		bookedOn: '2026-09-05',
		amount: 1_250_000,
		description: '盤筐体・制御機器'
	});
	await cost('a-mat2', {
		projectId: a.id,
		costType: 'material',
		bookedOn: '2026-10-20',
		amount: 420_000,
		description: 'ケーブル・端子類'
	});
	await cost('a-travel', {
		projectId: a.id,
		costType: 'travel',
		bookedOn: '2026-11-06',
		amount: 86_000,
		description: '現地出張 交通・宿泊'
	});
	await cost('b-out', {
		projectId: b.id,
		costType: 'outsource',
		vendorId: vendor,
		bookedOn: '2026-10-31',
		amount: 280_000,
		description: '帳票部分の外注'
	});
	await cost('a-prov', {
		entryKind: 'provisional',
		purchaseOrderId: order.id,
		bookedOn: '2026-10-31',
		amount: 350_000,
		description: '外注作業 10月分'
	});

	const { draft } = await api('POST', `/api/projects/${a.id}/forecast/draft`, {});
	const forecast = await api('PUT', `/api/forecast-versions/${draft.id}`, {
		rowVersion: draft.rowVersion,
		baseDate: '2026-10-31',
		reason: '10月末の見込',
		lines: [
			{ phaseId: 5, costType: 'labor', remainingMinutes: 2_400 },
			{ costType: 'material', amount: 150_000 },
			{ costType: 'outsource', amount: 250_000 },
			{ costType: 'travel', amount: 80_000 }
		]
	});
	await api('POST', `/api/forecast-versions/${draft.id}/adopt`, {
		rowVersion: forecast.rowVersion
	});

	await api('POST', '/api/fixed-costs/contracts', {
		projectId: e.id,
		payeeKind: 'vendor',
		vendorId: vendor,
		monthlyAmount: 120_000,
		fromMonth: '2026-06'
	});
	for (const month of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
		await api('POST', `/api/fixed-costs/months/${month}/post`, {});
	}
	await api('POST', '/api/outlook/snapshots', { label: '10月報告' });
	for (const month of ['2026-06', '2026-07', '2026-08', '2026-09']) {
		const view = await api('GET', `/api/closing/${month}`);
		await api('POST', `/api/closing/${month}/close`, { rowVersion: view.rowVersion });
	}
}

async function shoot() {
	mkdirSync(OUT, { recursive: true });
	// 手元の Chromium を使うときは CHROMIUM_PATH を指定する（例: /opt/pw-browsers/chromium）。
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		locale: 'ja-JP',
		timezoneId: 'Asia/Tokyo',
		deviceScaleFactor: 1
	});
	const page = await context.newPage();
	const file = (name) => path.join(OUT, `${name}.png`);

	await page.goto(BASE + '/');
	await page.getByLabel(/ユーザー名/).waitFor();
	await page.screenshot({ path: file('01-login'), clip: { x: 0, y: 0, width: 1280, height: 600 } });
	await page.getByLabel(/ユーザー名/).fill(USERNAME);
	await page
		.getByLabel(/パスワード/)
		.first()
		.fill(PASSWORD);
	await page.keyboard.press('Enter');
	await page.waitForURL(/dashboard/);

	const screen = async (url, name, height, width = 1280) => {
		await page.setViewportSize({ width, height: Math.max(height, 800) });
		await page.goto(BASE + url);
		// 変更通知（SSE）が張られたままなので networkidle にはならない。表示の落ち着きを待つ。
		await page.waitForTimeout(2000);
		await page.screenshot({ path: file(name), clip: { x: 0, y: 0, width, height } });
	};
	await screen('/dashboard', '02-dashboard', 500);
	await screen('/pipeline', '03-pipeline', 560);
	await screen('/outlook', '04-outlook', 760);
	await screen('/projects', '05-projects', 580, 1600);
	await screen('/customers', '06-customers', 360);
	await screen('/time', '08-time', 560);
	await screen('/approvals', '09-approvals', 420);
	await screen('/costs', '10-costs', 420);
	await screen('/calc-basis', '12-calc-basis', 640);
	await screen('/closing', '13-closing', 620);
	await screen('/fixed-costs', '14-fixed-costs', 560);
	await screen('/recurring-revenue', '15-recurring', 560);
	await screen('/work-masters', '16-work-masters', 560);

	// ユーザー管理：利用者を選ぶと編集パネルに「業務の能力」が出る。
	await page.setViewportSize({ width: 1280, height: 1200 });
	await page.goto(BASE + '/users');
	await page.getByRole('row').filter({ hasText: USERNAME }).first().click();
	await page.locator('.capability input').first().waitFor();
	await page.screenshot({ path: file('17-users'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
	await page.setViewportSize({ width: 1280, height: 800 });

	await screen('/projects/1', '07-project-detail', 800);
	// 案件の詳細は縦に長いので、欄ごとに切り出す（固定ヘッダが重ならないよう全体画像から切る）。
	for (const [heading, name] of [
		['受注・売上', '07a-order'],
		['予算', '07b-budget'],
		['完了見込', '07c-forecast'],
		['月別収支（年度またぎ・累計）', '07d-monthly'],
		['直接費・発注', '07e-costs'],
		['工数', '07f-time']
	]) {
		const section = page
			.getByRole('heading', { name: heading, exact: true })
			.first()
			.locator('xpath=ancestor::section[1]');
		await page.evaluate(() => window.scrollTo(0, 0));
		const box = await section.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
		});
		await page.screenshot({
			path: file(name),
			fullPage: true,
			clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 }
		});
	}
	await browser.close();
}

await seed();
await shoot();
console.log(`saved to ${OUT}`);
