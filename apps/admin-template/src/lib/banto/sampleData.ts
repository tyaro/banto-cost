/**
 * Demo-mode seed for the in-memory DataProvider (no backend: `vite dev` /
 * `vite preview` / a `VITE_BANTO_DEMO=1` build, conventions §10). Replaces
 * the template's 10,000-row `items` demo (removed in banto-cost, 2026-11).
 *
 * Every name here is fictional (banto-cost CLAUDE.md: no real customers,
 * people or amounts). The rows are deterministic - fixed arrays and a pure
 * generator, no clock or random source - so the visual regression snapshots
 * that run in demo mode stay stable.
 *
 * Only the `customers` / `projects` ledgers exist in demo mode. Pipeline
 * versions, orders and the outlook are server aggregates with no in-memory
 * counterpart (pipelineAdmin.ts rejects with `DEMO_MODE_MESSAGE`).
 */
import type { Customer } from './resources/customers';
import type { Project } from './resources/projects';

const UPDATED_AT = '2026-10-01';

const CUSTOMER_NAMES = [
	'見本工業',
	'試作電機',
	'例示精機',
	'架空システム',
	'模擬製作所',
	'仮設商事',
	'雛形エンジニアリング',
	'参考テクノ'
];

/** Fictional customers; the last one is inactive so the grid shows both states. */
export const sampleCustomers: (Customer & Record<string, unknown>)[] = CUSTOMER_NAMES.map(
	(name, index) => ({
		id: index + 1,
		name,
		active: index !== CUSTOMER_NAMES.length - 1,
		note: null,
		rowVersion: 1,
		updatedAt: UPDATED_AT
	})
);

const PROJECT_SUBJECTS = [
	'生産ライン監視画面',
	'設備データ収集',
	'検査装置ソフト改修',
	'保守契約',
	'帳票出力の追加',
	'在庫連携',
	'稼働率集計',
	'制御盤更新'
];

const STATUSES = [
	'lead',
	'quoting',
	'negotiating',
	'ordered',
	'in_progress',
	'work_done',
	'settled',
	'lost',
	'on_hold'
];

const MANAGERS = ['担当 一郎', '担当 花子', '担当 次郎'];

/** `YYYY-MM`, `offset` months after the start of 第13期 (2026-06). */
function fiscalMonth(offset: number): string {
	const monthIndex = 5 + offset; // 0-based from January 2026; 5 = June
	const year = 2026 + Math.floor(monthIndex / 12);
	const month = (monthIndex % 12) + 1;
	return `${year}-${String(month).padStart(2, '0')}`;
}

/** 24 fictional projects spread over the customers, statuses and the fiscal year. */
export const sampleProjects: (Project & Record<string, unknown>)[] = Array.from(
	{ length: 24 },
	(_, index) => {
		const customer = sampleCustomers[index % sampleCustomers.length];
		const status = STATUSES[index % STATUSES.length];
		const start = fiscalMonth(index % 12);
		const end = fiscalMonth((index % 12) + 2);
		const ordered = ['ordered', 'in_progress', 'work_done', 'settled'].includes(status);
		return {
			id: index + 1,
			code: `P13-${String(index + 1).padStart(3, '0')}`,
			name: `${customer.name} ${PROJECT_SUBJECTS[(index + Math.floor(index / PROJECT_SUBJECTS.length)) % PROJECT_SUBJECTS.length]}`,
			customerId: customer.id,
			customerName: customer.name,
			managerUserId: (index % MANAGERS.length) + 1,
			managerName: MANAGERS[index % MANAGERS.length],
			status,
			plannedStart: `${start}-01`,
			plannedEnd: `${end}-28`,
			orderNo: ordered ? `PO-${String(1000 + index)}` : null,
			department: index % 2 === 0 ? 'システム課' : '制御課',
			note: null,
			rowVersion: 1,
			updatedAt: UPDATED_AT
		};
	}
);
