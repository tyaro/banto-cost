#!/usr/bin/env node
/**
 * プリセット・スキャフォールド（improvement-plan-2026-07.md P4-9 /
 * docs/design/scaffold-presets-plan.md）。
 *
 * Banto をコピーした直後に、選んだプリセットで**不要なオプション資産を削除**
 * する。テンプレート本体は「全部入り（full）」で出荷され、スキャフォールドは
 * 「引く」だけ（＝資産を足すことは一切しない。plan §7.1 の ship-full/remove-only
 * 決定）。コア（auth/RBAC/audit/settings/backup/CSV/shell）には一切触れない。
 *
 * プリセット（✓＝残す / ✗＝削除。plan §3）:
 *   - minimal  … コアのみ（charts/dock/glass/commandPalette/attachments/report/tree を全削除）
 *   - standard … ダッシュボード体験を残す（attachments/report/tree を削除）
 *   - full     … 何も削除しない（検証のみ）
 *   - display  … 表示専用アプリ（カンバン/常設ダッシュボード/展示デモ）。
 *                minimal が外すもの全部 + items デモリソース一式 + users /
 *                audit-log **画面** + /dashboard を外し、`/monitor` を足して
 *                既定値を反転する（docs/design/display-preset-plan.md §3.2、Issue #190）。
 *   ※ scan-wedge は現状レシピのみ・未配線なので scaffold は一切触れない（plan §3）。
 *     image-assets（ADR-0020 §6）も同じく未配線（アプリが依存しない）なので触れない。
 *
 * 各資産の削除は docs/recipes/remove-optional-assets.md（旧 README「3. オプション
 * 資産の削除」）の手動手順を 1 対 1 で自動化した
 * 単一の remover 関数に閉じる。プリセットは「どの remover を呼ぶか」の集合。
 * 編集エンジン（現在値を読んで置換・再実行安全・`--dry-run`・見つからない
 * パターンは明示的失敗）は rename.mjs と共有する scripts/lib/template-edit.mjs。
 * 依存は足さない（Node 標準のみ、conventions §3 / ADR-0002）。
 *
 * **display だけは「引く」に加えて「足す」工程を持つ**（plan §2 原則 1 の
 * 範囲内: 足すのは①既にテンプレート本体にあるトグルの**既定値の反転**と、
 * ②`scripts/lib/templates/display/` に置いた**雛形ファイルの複製**だけで、
 * scaffold 出力にしか存在しないロジックは作らない）。この工程は
 * `applyDisplayDefaults()` に閉じ、他の remover と同じ編集エンジンを通るので
 * `--dry-run` の計画表示も `--strict` の扱いも removers と同一になる。
 *
 * **全プリセット共通（full を含む）で、banto 本体のリリース検証専用のもの
 * （外部利用 fixture 一式、#271）を除去する**（`removeBantoReleaseOnly()`）。
 * fixture は `github:tyaro/banto#<sha>` を取りに行く banto 本体の検証で、派生
 * アプリには意味が無い（派生側の SHA は tyaro/banto に無い）うえ、crates/ を
 * 減らすプリセットでは verify:architecture の fixture 検査と食い違う。資産の
 * 選択（`toRemove`）とは独立した工程なので、計画表示では `# bantoReleaseOnly`
 * として常に出る。
 *
 * 使い方:
 *   node scripts/scaffold.mjs --preset minimal|standard|full|display [--dry-run]
 *   node scripts/scaffold.mjs --interactive|-i [--dry-run]
 *
 * `--interactive`（plan §7.3）は人間に対話でプリセット（または個別資産の
 * 残す/削除）を選ばせた上で、`--preset` と**全く同じ削除ロジック**
 * （`toRemove` の Set → ORDER に沿った remover 呼び出し）を実行する。
 * 依存を足さない文化に従い Node 標準の `node:readline/promises` のみを使う
 * （新規依存なし、conventions §3 / ADR-0002）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { createEditor, dropBlock, swap, cut, cutToEnd } from './lib/template-edit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 引数 -------------------------------------------------------------------

/** minimal が外すオプション資産（display はこれを全部含む）。 */
const OPTIONAL_ASSETS = [
	'charts',
	'dock',
	'glass',
	'commandPalette',
	'attachments',
	'report',
	'tree'
];

const PRESETS = {
	// 値 = 削除する資産の集合（残すものは書かない）。
	minimal: [...OPTIONAL_ASSETS],
	standard: ['attachments', 'report', 'tree'],
	full: [],
	// display だけ「デモ資産」（items / 管理画面 / ダッシュボード）にも及ぶ。
	// 末尾の `displayDefaults` は唯一の「足す」工程（ファイル冒頭 doc 参照）。
	display: [...OPTIONAL_ASSETS, 'items', 'adminPages', 'dashboard', 'displayDefaults']
};

function usage(code) {
	console.log(
		'使い方: node scripts/scaffold.mjs --preset minimal|standard|full|display [--dry-run] [--strict]\n' +
			'       node scripts/scaffold.mjs --interactive|-i [--dry-run]\n' +
			'  minimal     … コアのみ（全オプション資産を削除）\n' +
			'  standard    … dock/charts/コマンドパレット/Glass を残し、添付・帳票・ツリーを削除\n' +
			'  full        … オプション資産を何も削除しない（banto 本体専用の検証\n' +
			'                fixture の除去だけ。全プリセット共通）\n' +
			'  display     … 表示専用アプリ: minimal の削除 + items デモ一式 + users/audit-log 画面\n' +
			'                + /dashboard を削除し、/monitor・初回起動シード・キオスク既定・\n' +
			'                i18n raw を入れる（docs/design/display-preset-plan.md）\n' +
			'  --interactive/-i … プリセット（または資産ごとの残す/削除）を対話で選ぶ。\n' +
			'                      --preset とは併用不可\n' +
			'  --strict    … pristine コピー専用: 「適用済み扱い」をアンカードリフトとして失敗にする\n' +
			'                （再実行安全性が消えるため通常運用では付けない。CI の受け入れ検査用）'
	);
	process.exit(code);
}

function fail(message) {
	console.error(`エラー: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = { dryRun: false, interactive: false, strict: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--preset') {
			args.preset = argv[++i];
			if (args.preset === undefined) fail('--preset に値がありません');
		} else if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--strict') args.strict = true;
		else if (arg === '--list-touched') args.listTouched = true;
		else if (arg === '--list-presets') args.listPresets = true;
		else if (arg === '--interactive' || arg === '-i') args.interactive = true;
		else if (arg === '--help' || arg === '-h') usage(0);
		else fail(`不明な引数: ${arg}`);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
// 内部用（scripts/lib/scaffold-touched.mjs）。プリセット名を手書きで複製させず、
// PRESETS のキーをそのまま出して終了する。
if (args.listPresets) {
	for (const name of Object.keys(PRESETS)) console.log(name);
	process.exit(0);
}
if (args.interactive && args.preset)
	fail('--interactive と --preset は同時に指定できません（どちらか一方を選んでください）');
if (args.interactive && args.strict)
	fail('--strict は --preset 専用です（CI の pristine コピー検査用。対話モードでは使えません）');
if (!args.interactive && !args.preset) usage(1);
if (args.listTouched && !args.dryRun) fail('--list-touched は --dry-run 専用です（内部用）');
if (args.preset && !Object.prototype.hasOwnProperty.call(PRESETS, args.preset))
	fail(
		`--preset は ${Object.keys(PRESETS).join(' / ')} のいずれかを指定してください: ${args.preset}`
	);

// --- 編集エンジン -----------------------------------------------------------

const editor = createEditor({ repoRoot, dryRun: args.dryRun, strict: args.strict });
const { addFile, beginStep, editFile, editRemoval, removeFile, removeDir } = editor;

// 削除系（cutRegion / drop / cutEnd / removeMessageKeys）は editRemoval を通す。
// 見つからないときは、工程の印（STEP_MARKERS）がまだ在る＝初回適用なら失敗、
// 印が既に無い＝再実行なら適用済み（template-edit.mjs の editRemoval）。

/** 連続領域を start..end（両端含む）で削除。短い一意アンカーで巨大ブロックを消す。 */
function cutRegion(rel, label, start, end) {
	editRemoval(rel, label, (s) => cut(s, start, end));
}
/** 1 ブロック（行や連続領域）を丸ごと削除（冪等・初回適用で見つからなければ失敗）。 */
function drop(rel, label, block) {
	editRemoval(rel, label, (s) => dropBlock(s, block));
}
/** marker から EOF までを削除（末尾は単一改行に整える・冪等）。章末の付録ブロック向け。 */
function cutEnd(rel, label, marker) {
	editRemoval(rel, label, (s) => cutToEnd(s, marker));
}
/** from → to へ冪等に置換（どちらも無ければ失敗）。 */
function swapText(rel, label, from, to) {
	editFile(rel, label, (s) => swap(s, from, to));
}
/** apps/admin-template/package.json から workspace 依存 1 行を削除。 */
function removeAppDep(dep) {
	drop(APP_PKG, `dependency ${dep} を除去`, `    "${dep}": "workspace:*",\n`);
}

/**
 * `// [scaffold:<tag>] begin` … `// [scaffold:<tag>] end` で挟まれた領域を
 * **1つ**削除する（display-preset-plan.md D1-d のマーカー方式）。
 *
 * アンカーに直前の改行と `indent` を含めるので、(1) 同じファイル内の
 * インデント違いのマーカーを取り違えない（`\n// …` は列0のマーカーにしか
 * 当たらない）、(2) 削除後に空白だけの行が残らない（rustfmt/prettier 整合）。
 * 同じ tag/indent の領域が複数あるファイルでは、**出現順に 1 回ずつ**呼ぶ
 * （`cut` は最初の一致を消すので、n 回呼べば n 個が上から順に消える）。
 */
function cutMarked(rel, label, tag, indent = '') {
	cutRegion(rel, label, `\n${indent}// [scaffold:${tag}] begin`, `// [scaffold:${tag}] end`);
}

/**
 * `messages/{ja,en}.json` から**キー接頭辞**でメッセージを取り除く
 * （`prefix` そのもの、または `prefix + '.'` で始まるキー）。
 *
 * 辞書は「1行1キー・2スペース・キー順保持」の prettier 整形なので、
 * JSON としてパース→フィルタ→`JSON.stringify(…, null, 2)` で往復しても
 * バイト等価になる（本リポジトリで検証済み）。行単位の正規表現より安全で、
 * 末尾要素のカンマ問題も起きない。
 * 1件も消えなければ `null`（再実行なら適用済み / 初回適用・`--strict` では失敗）。
 */
function removeMessageKeys(rel, label, prefixes, keep = []) {
	const keepSet = new Set(keep);
	const matches = (key) =>
		!keepSet.has(key) && prefixes.some((p) => key === p || key.startsWith(`${p}.`));
	editRemoval(rel, label, (s) => {
		const before = JSON.parse(s);
		const after = Object.fromEntries(Object.entries(before).filter(([key]) => !matches(key)));
		if (Object.keys(after).length === Object.keys(before).length) return null;
		return `${JSON.stringify(after, null, 2)}\n`;
	});
}

/**
 * `messages/{ja,en}.json` に 1 キーを `anchor` の**直前**へ挿入する
 * （キー順を保つための位置指定。`removeMessageKeys` と同じ往復整形）。
 * 既に同じ値で在れば `null`（適用済み）、`anchor` が無ければ `undefined`（失敗）。
 */
function addMessageKey(rel, label, anchor, key, value) {
	editFile(rel, label, (s) => {
		const before = JSON.parse(s);
		if (before[key] === value) return null;
		if (!(anchor in before)) return undefined;
		const after = {};
		for (const [k, v] of Object.entries(before)) {
			if (k === anchor) after[key] = value;
			if (k !== key) after[k] = v;
		}
		return `${JSON.stringify(after, null, 2)}\n`;
	});
}

/** `scripts/lib/templates/` の雛形を読む（display の「足す」工程の素材）。 */
function readTemplate(templateRel) {
	const abs = path.join(repoRoot, 'scripts/lib/templates', templateRel);
	try {
		return fs.readFileSync(abs, 'utf8');
	} catch {
		return fail(`雛形 scripts/lib/templates/${templateRel} が見つかりません`);
	}
}

/** 雛形を**新規ファイル**として置く（既存があれば衝突として失敗）。 */
function copyTemplate(templateRel, destRel, label) {
	addFile(destRel, label, readTemplate(templateRel));
}

/**
 * 雛形で**既存ファイルを丸ごと差し替える**（内容が既に一致していれば適用済み）。
 * 「削除してから作る」にすると `--dry-run`（実際には消さない）で衝突扱いに
 * なってしまうため、1つの冪等な編集として表現する。
 */
function copyTemplateOver(templateRel, destRel, label) {
	const content = readTemplate(templateRel);
	editFile(destRel, label, (s) => (s === content ? null : content));
}

// --- パス定数 ---------------------------------------------------------------

const APP = 'apps/admin-template';
const APP_PKG = `${APP}/package.json`;
const VITE = `${APP}/vite.config.ts`;
const DASH = `${APP}/src/routes/(app)/dashboard/+page.svelte`;
const DASH_LIB = `${APP}/src/lib/banto/dashboard.ts`;
const LAYOUT = `${APP}/src/routes/(app)/+layout.svelte`;
const HEADER = `${APP}/src/lib/components/Header.svelte`;
// settings-split refactor (choiapp-feedback-2026-09 §3): the glass/vibrancy
// UI removeGlass() edits below live in the 外観 (appearance) category's own
// section component, not in +page.svelte itself anymore.
const SETTINGS_APPEARANCE = `${APP}/src/routes/(app)/settings/AppearanceSection.svelte`;
const ITEMS = `${APP}/src/routes/(app)/items/+page.svelte`;
const ITEM_EDIT = `${APP}/src/routes/(app)/items/[id]/+page.svelte`;
const APP_CSS = `${APP}/src/app.css`;
const THEME_INDEX = 'packages/theme/src/index.ts';
const THEME_CSS = 'packages/theme/src/css/banto.css';
const VERIFY_ARCH = 'scripts/verify-architecture.mjs';
const REST_MOD = `${APP}/core/src/rest/mod.rs`;
const REST_ITEMS = `${APP}/core/src/rest/items.rs`;
const REST_TESTS = `${APP}/core/src/rest/tests.rs`;
const BANTO_SERVE = `${APP}/core/src/bin/banto-serve.rs`;
const LIB_RS = `${APP}/src-tauri/src/lib.rs`;
const WS_CARGO = 'Cargo.toml';
const CORE_CARGO = `${APP}/core/Cargo.toml`;
const TAURI_CARGO = `${APP}/src-tauri/Cargo.toml`;
// display プリセット（items / adminPages / dashboard / displayDefaults）の対象。
const NAV = `${APP}/src/lib/navigation.ts`;
const NAV_ICONS = `${APP}/src/lib/components/navIcons.ts`;
const I18N = `${APP}/src/lib/banto/i18n.ts`;
const MSG_JA = `${APP}/messages/ja.json`;
const MSG_EN = `${APP}/messages/en.json`;
const CORE_LIB = `${APP}/core/src/lib.rs`;
const CORE_DB = `${APP}/core/src/db.rs`;
const FIRST_BOOT = `${APP}/core/src/first_boot.rs`;
const SETUP_TS = `${APP}/src/lib/banto/setup.ts`;
const RESOURCES_INDEX = `${APP}/src/lib/banto/resources/index.ts`;
const SETTINGS_STORE = `${APP}/src/lib/settings.svelte.ts`;
const ROOT_PAGE_TS = `${APP}/src/routes/+page.ts`;
const LOGIN = `${APP}/src/routes/login/+page.svelte`;
const ROOT_PKG = 'package.json';
const PLAYWRIGHT_CONFIG = 'e2e/playwright.config.ts';
const E2E_SMOKE = 'e2e/tests/smoke.spec.ts';
const CI_WORKFLOW = '.github/workflows/ci.yml';

// --- removers（docs/recipes/remove-optional-assets.md の手動手順の 1 対 1 自動化） ---

/**
 * `@banto/charts`（SVGチャート）。remove-optional-assets.md「`@banto/charts`」。
 * ダッシュボードのチャートデモ配線・DashboardPanel・@banto/charts 依存を外す。
 * `dashboard.ts` はスタットタイルが `computeStatTiles` を使うため残す（未使用の
 * 集計エクスポートはビルドを壊さない）。stat タイルの Sparkline のみ外す。
 *
 * ドリフト注意: dashboard/+page.svelte の チャート markup・見出し・派生を
 * 変えたら（特に #74 M24 で追加した StackedAreaChart/GanttChart セクション、
 * i18n キー化で可視文言が `m['...']()` になった箇所）このパターンも更新すること。
 * charts 除去後に dashboard/+page.svelte と dashboard.ts に `@banto/charts` 参照が
 * 一切残らないことが不変条件（残ると `Cannot find module '@banto/charts'` /
 * 未定義コンポーネント / 暗黙 any でチェックが赤くなる）。
 */
function removeCharts() {
	cutRegion(DASH, 'charts import 除去', `\timport {\n\t\tBarChart,`, `} from '@banto/charts';`);
	drop(
		DASH,
		'DashboardPanel import 除去',
		`\timport DashboardPanel from '#lib/components/DashboardPanel.svelte';\n`
	);
	// #74 M24: 積立エリア/ガントは dashboard.ts の集計に依存する。charts 除去後に
	// dashboard.ts から `@banto/charts`（GanttTask 型）参照が残らないよう、対応する
	// import・派生・markup をここで確実に外す。
	drop(DASH, 'M24 集計 import(categoryTrendByMonth)除去', `\t\tcategoryTrendByMonth,\n`);
	drop(DASH, 'M24 集計 import(inventorySchedule)除去', `\t\tinventorySchedule,\n`);
	drop(DASH, 'M24 型 import(MonthCategoryCount)除去', `\t\ttype MonthCategoryCount,\n`);
	drop(
		DASH,
		'M24 派生(categoryTrend/schedule)除去',
		`\t// M24 chart types (spec §6.1, roadmap.md M24): stacked area (積立エリア), Gantt.\n\tconst categoryTrend = $derived(categoryTrendByMonth(list.rows));\n\tconst schedule = $derived(inventorySchedule(list.rows));\n\n`
	);
	cutRegion(
		DASH,
		'formatGanttDate ヘルパ除去',
		`\t// UTC getters (not toLocaleDateString): the schedule's dates are UTC`,
		`\t};`
	);
	drop(
		DASH,
		'stat タイルの Sparkline 除去',
		`\t\t\t\t\t<Sparkline values={monthCounts.map((mc) => mc.count)} width={72} height={24} />\n`
	);
	cutRegion(DASH, 'チャートグリッド(トレンド系)除去', `\t\t<div class="chart-grid">`, `\t\t</div>`);
	drop(
		DASH,
		'チャート拡張見出し(v2)除去',
		`\t\t<h2 class="section-heading">{m['dashboard.chartsV2Heading']()}</h2>\n`
	);
	cutRegion(DASH, 'チャートグリッド(拡張)除去', `\t\t<div class="chart-grid">`, `\t\t</div>`);
	drop(
		DASH,
		'チャート拡張見出し(M24)除去',
		`\t\t<h2 class="section-heading">{m['dashboard.chartsM24Heading']()}</h2>\n`
	);
	cutRegion(DASH, 'チャートグリッド(M24)除去', `\t\t<div class="chart-grid">`, `\t\t</div>`);
	// dashboard.ts（stat タイル用に残すが M24 集計だけは `@banto/charts` の GanttTask に
	// 依存するので切り離す）。GanttTask import と M24 セクション（EOFまで）を外す。
	drop(
		DASH_LIB,
		'dashboard.ts: GanttTask import 除去',
		`import type { GanttTask } from '@banto/charts';\n`
	);
	cutEnd(DASH_LIB, 'dashboard.ts: M24 集計セクション(EOFまで)除去', `// --- M24 chart demo data`);
	removeFile(`${APP}/src/lib/components/DashboardPanel.svelte`, 'DashboardPanel.svelte 削除');
	removeAppDep('@banto/charts');
}

/**
 * `@banto/dock-svelte`（ダッシュボードのドッキング）。remove-optional-assets.md「`@banto/dock-svelte`」。
 * ダッシュボードの Dock 配線一式・panels.ts・popout.ts・@banto/dock-svelte 依存に
 * 加え、pop-out 先の `routes/panel/[id]`（panels.ts / DashboardPanel に依存）も削除。
 */
function removeDock() {
	cutRegion(DASH, 'dock import 除去', `\timport {\n\t\tDockHost,`, `} from '@banto/dock-svelte';`);
	swapText(DASH, 'lucide から LayoutGrid 除去', `LayoutGrid, JapaneseYen`, `JapaneseYen`);
	drop(DASH, 'panels import 除去', `\timport { PANEL_DEFS } from '#lib/banto/panels.js';\n`);
	drop(
		DASH,
		'setup(getUiSettings/isTauri) import 除去',
		`\timport { getUiSettings, isTauri } from '#lib/banto/setup.js';\n`
	);
	drop(
		DASH,
		'popout import 除去',
		`\timport { listenPanelClosed, openPanelWindow } from '#lib/banto/popout.js';\n`
	);
	// #433-b（#446）: dock の gesture の Esc をどの層に譲るか。dock と一緒に消える。
	drop(
		DASH,
		'dockEscape import 除去',
		`\timport { isDockEscapeBlocked } from '#lib/banto/dockEscape.js';\n`
	);
	// #432 PR-10: メモ pane の draft と dock の lifecycle の配線（中身は下の「dock スクリプト
	// 一式」・ワークスペース markup・dockPanel snippet の範囲に収めてある）。
	drop(
		DASH,
		'メモ pane（draft・確認ダイアログ）import 除去',
		`\timport {\n\t\tMEMO_PANEL_ID,\n\t\tcreateDashboardMemo,\n\t\tcreatePanelChangeHandler,\n\t\tmemoSaveCommand\n\t} from '#lib/banto/dashboardMemo.svelte.js';\n` +
			// #435 PR-11: メモの Ctrl+S（登録は下の「dock スクリプト一式」の範囲）。
			// shortcuts.ts 自体はアプリの dispatcher としてコアに残る。
			`\timport { appShortcuts, firstPressOnly, SAVE_SHORTCUT } from '#lib/shortcuts.js';\n` +
			`\timport { createSettlePrompt } from '#lib/banto/settlePrompt.svelte.js';\n` +
			`\timport { untrack } from 'svelte';\n` +
			`\timport { formValidationMessages } from '#lib/banto/i18n.js';\n` +
			`\timport { guardUnsavedChanges } from '#lib/unsavedChanges.js';\n` +
			`\timport type { DraftSettleResult } from '@banto/forms';\n` +
			`\timport DashboardMemoField from '#lib/components/DashboardMemoField.svelte';\n` +
			`\timport DraftSettleDialog from '#lib/components/DraftSettleDialog.svelte';\n`
	);
	cutRegion(
		DASH,
		'dock スクリプト一式除去',
		`\t/**\n\t * M8 dock demo (spec §5, @banto/dock-svelte):`,
		`\t\treturn listenPanelClosed((id) => dock.open(id));\n\t});`
	);
	cutRegion(
		DASH,
		'分析ワークスペース(dock)markup 除去',
		`\t\t<section class="workspace">`,
		`\t\t</section>`
	);
	cutRegion(
		DASH,
		'dockPanel snippet 除去',
		`{#snippet dockPanel(content: PanelContent)}`,
		`{/snippet}`
	);
	removeFile(`${APP}/src/lib/banto/panels.ts`, 'panels.ts 削除');
	removeFile(`${APP}/src/lib/banto/popout.ts`, 'popout.ts 削除');
	removeFile(`${APP}/src/lib/banto/dockEscape.ts`, 'dockEscape.ts 削除');
	removeFile(`${APP}/src/lib/banto/dockEscape.test.ts`, 'dockEscape.test.ts 削除');
	removeFile(`${APP}/src/lib/banto/dashboardMemo.svelte.ts`, 'dashboardMemo.svelte.ts 削除');
	removeFile(`${APP}/src/lib/banto/dashboardMemo.test.ts`, 'dashboardMemo.test.ts 削除');
	removeFile(`${APP}/src/lib/banto/settlePrompt.svelte.ts`, 'settlePrompt.svelte.ts 削除');
	removeFile(`${APP}/src/lib/banto/settlePrompt.test.ts`, 'settlePrompt.test.ts 削除');
	removeFile(`${APP}/src/lib/components/DashboardMemoField.svelte`, 'DashboardMemoField 削除');
	removeFile(`${APP}/src/lib/components/DraftSettleDialog.svelte`, 'DraftSettleDialog 削除');
	removeDir(`${APP}/src/routes/panel`, 'pop-out panel ルート削除');
	removeAppDep('@banto/dock-svelte');
	// dock-svelte は .svelte.ts を持つので optimizeDeps.exclude（issue #150 / ADR-0007）に
	// も載っている。依存を外すと verify:architecture の optimizedeps-svelte-source が
	// 「不要なのに登録」で落ちるため、exclude 行も外す（末尾要素ではないので行ごと）。
	drop(VITE, 'vite: optimizeDeps.exclude から dock-svelte 除去', `\t\t\t'@banto/dock-svelte',\n`);
}

/**
 * Glass テーマ + Windows vibrancy（M12）。remove-optional-assets.md「Glassテーマ + Windows vibrancy」。
 * banto-glass.css / ThemePreset の 'glass' / 設定画面のプリセット選択肢を外し、
 * 併せて本物のガラス感（Windows Acrylic）= vibrancy も外す。
 * src-tauri（lib.rs / Cargo）は本サンドボックスでは非コンパイル（コードレビュー担保）。
 */
function removeGlass() {
	// --- テーマパッケージ ---
	swapText(
		THEME_INDEX,
		"ThemePreset union から 'glass' 除去",
		`export type ThemePreset = 'standard' | 'glass';`,
		`export type ThemePreset = 'standard';`
	);
	swapText(
		THEME_INDEX,
		"isThemePreset から 'glass' 除去",
		`return value === 'standard' || value === 'glass';`,
		`return value === 'standard';`
	);
	drop(THEME_CSS, 'banto-glass.css の @import 除去', `@import './banto-glass.css';\n`);
	removeFile('packages/theme/src/css/banto-glass.css', 'banto-glass.css 削除');

	// --- 設定画面: プリセット選択肢 + vibrancy 配線 ---
	// settings-split refactor（choiapp-feedback-2026-09 §3）で、これらは
	// +page.svelte から外観カテゴリの AppearanceSection.svelte へ移った
	// （SETTINGS_APPEARANCE）。
	// ドリフト注意: i18n キー化で label が `m['settings.presetGlass']()` になった。
	// プリセット選択肢 markup を変えたらこのパターンも更新すること（残ると
	// ThemePreset から 'glass' を外した後 `Type '"glass"' is not assignable
	// to type '"standard"'` でチェックが赤くなる）。
	drop(
		SETTINGS_APPEARANCE,
		'プリセット選択肢からガラス除去',
		`\t\t{ value: 'glass', label: m['settings.presetGlass']() }\n`
	);
	drop(
		SETTINGS_APPEARANCE,
		'vibrancy import 除去',
		`\timport { applyVibrancy, getVibrancyStatus, type VibrancyStatus } from '#lib/banto/vibrancy.js';\n`
	);
	drop(SETTINGS_APPEARANCE, 'Sparkles アイコン import 除去', `\t\tSparkles,\n`);
	cutRegion(
		SETTINGS_APPEARANCE,
		'vibrancy 状態/ロジック除去',
		`\t// --- M12: window vibrancy`,
		`\t\t\tapplyingVibrancy = false;\n\t\t}\n\t}`
	);
	cutRegion(
		SETTINGS_APPEARANCE,
		'ウィンドウ効果カード(markup)除去',
		`\t{#if tauri && isAdmin(sessionStore.role) && vibrancyStatus?.supported}`,
		`\t{/if}`
	);
	removeFile(`${APP}/src/lib/banto/vibrancy.ts`, 'vibrancy.ts 削除');
	// src-tauri（lib.rs / Cargo）は removeGlassSrcTauri() で別途実行（非コンパイル）。
}

/**
 * コマンドパレット（Ctrl+K、M16）。remove-optional-assets.md「コマンドパレット」。
 * CommandPalette.svelte / commandPalette.svelte.ts / commands.ts を削除し、
 * (app)/+layout.svelte と Header.svelte からの参照を外す。
 */
function removeCommandPalette() {
	// layout: import・Ctrl+K・パレット描画
	drop(
		LAYOUT,
		'CommandPalette import 除去',
		`\timport CommandPalette from '#lib/components/CommandPalette.svelte';\n`
	);
	drop(
		LAYOUT,
		'commandPaletteStore import 除去',
		`\timport { commandPaletteStore } from '#lib/commandPalette.svelte.js';\n`
	);
	// #435 PR-11: Ctrl+K はアプリの shortcut dispatcher（`#lib/shortcuts.ts`）の command。
	// dispatcher 自体はページの command（ダッシュボードの Ctrl+S）のためにコアに残し、
	// パレットの command の登録と、その ownerLayer を探すための host だけを外す。
	swapText(
		LAYOUT,
		'shortcuts import からパレットの command を除去',
		`\timport { appShortcuts, commandPaletteCommand } from '#lib/shortcuts.js';\n`,
		`\timport { appShortcuts } from '#lib/shortcuts.js';\n`
	);
	cutRegion(
		LAYOUT,
		'Ctrl+K（パレットの command）の登録除去',
		`\t// Ctrl+K / Cmd+K (spec M16): a global toggle registered here (the app`,
		`\t\t\t])\n\t\t)\n\t);\n\n`
	);
	swapText(
		LAYOUT,
		'handleKeydown からパレット参照を除去',
		`\t\tif (event.key === 'Escape' && overlayOpen && !commandPaletteStore.open) {`,
		`\t\tif (event.key === 'Escape' && overlayOpen) {`
	);
	// 最近使った項目の所有者掃除（#258）: パレットと一緒に recentCommands.ts を消すため配線も外す。
	drop(
		LAYOUT,
		'recentCommands import 除去',
		`	import { watchRecentCommandOwner } from '#lib/recentCommands.js';
`
	);
	drop(
		LAYOUT,
		'パレット履歴の所有者掃除 $effect 除去',
		`	// Command palette history is per user (#258): dropped on a confirmed
	// \`none\`, and another owner's entry dropped once an owner is confirmed
	// (the same hygiene the controller does for the list view state). The
	// owner check on read is the safety boundary; this only avoids lingering.
	$effect(() => untrack(() => watchRecentCommandOwner(sessionController)));

`
	);
	drop(
		LAYOUT,
		'CommandPalette 描画除去',
		`{#if commandPaletteStore.open}\n` +
			`\t<!-- The host only lets the Ctrl+K command find the palette's dialog (its\n` +
			`\t     \`ownerLayer\`); \`display: contents\` keeps it out of the layout. -->\n` +
			`\t<div class="palette-host" bind:this={paletteHost}>\n\t\t<CommandPalette />\n\t</div>\n{/if}\n\n`
	);
	drop(LAYOUT, 'パレットの host の CSS 除去', `\t.palette-host {\n\t\tdisplay: contents;\n\t}\n\n`);

	// header: import・検索ピル/アイコンボタン
	drop(
		HEADER,
		'commandPaletteStore import 除去',
		`\timport { commandPaletteStore } from '#lib/commandPalette.svelte.js';\n`
	);
	drop(
		HEADER,
		'shortcuts import 除去（検索ピルの鍵帽の表示だけが使う）',
		`\timport { appShortcuts, COMMAND_PALETTE_SHORTCUT } from '#lib/shortcuts.js';\n`
	);
	drop(
		HEADER,
		'lucide から Search 除去',
		`		Search,
`
	);
	// キオスク表示（display-preset-plan.md D1-b）で検索ピルは `{#if !settings.kiosk}`
	// 分岐に入った。パレットを外すときは分岐ごと消し、`{:else}` 側（全画面ボタン）
	// だけを `{#if settings.kiosk}` として残す。
	swapText(
		HEADER,
		'検索ピル/コマンドパレット起動ボタン除去',
		`{#if !settings.kiosk}
		<button
			type="button"
			class="search-pill"
			title={m['shell.openCommandPalette']()}
			onclick={() => commandPaletteStore.show()}
		>
			<Search size={16} aria-hidden="true" />
			<span>{m['shell.searchPlaceholder']()}</span>
			<!-- The dispatcher's key, as the platform writes it (Ctrl+K / ⌘K, #435). -->
			<kbd>{appShortcuts.format(COMMAND_PALETTE_SHORTCUT)}</kbd>
		</button>
		<div class="search-icon-only">
			<IconButton
				label={m['shell.openCommandPalette']()}
				icon={Search}
				onclick={() => commandPaletteStore.show()}
			/>
		</div>
	{:else}
`,
		`{#if settings.kiosk}
`
	);

	removeFile(`${APP}/src/lib/components/CommandPalette.svelte`, 'CommandPalette.svelte 削除');
	removeFile(`${APP}/src/lib/commandPalette.svelte.ts`, 'commandPalette.svelte.ts 削除');
	removeFile(`${APP}/src/lib/commands.ts`, 'commands.ts 削除');
	removeFile(`${APP}/src/lib/commands.test.ts`, 'commands.test.ts 削除');
	removeFile(`${APP}/src/lib/recentCommands.ts`, 'recentCommands.ts 削除');
	removeFile(`${APP}/src/lib/recentCommands.test.ts`, 'recentCommands.test.ts 削除');
}

/**
 * 添付ファイル（`@banto/attachments` + items 添付デモ、M20）。remove-optional-assets.md「添付ファイル機能」。
 * remove-optional-assets.md の 6 ステップ順（依存の少ない順）で外す。src-tauri（lib.rs / Cargo）は
 * 非コンパイル・コードレビュー担保。rest/tests.rs（`cargo test` 対象）も併せて
 * 更新し、全プリセットで `cargo test` が緑になるようにする。
 */
function removeAttachments() {
	// (1) フロント: items/[id] の AttachmentsPanel 配線 + 関連 import
	drop(
		ITEM_EDIT,
		'AttachmentsPanel import 除去',
		`\timport { AttachmentsPanel } from '@banto/attachments';\n`
	);
	drop(
		ITEM_EDIT,
		'isAttachmentsAvailable import 除去',
		`\timport { isAttachmentsAvailable } from '#lib/banto/attachmentsAdmin.js';\n`
	);
	drop(
		ITEM_EDIT,
		'attachmentsClient import 除去',
		`\timport { attachmentsClient } from '#lib/banto/attachmentsClient.js';\n`
	);
	cutRegion(
		ITEM_EDIT,
		'AttachmentsPanel markup 除去',
		`\t<!--\n\t\tM20 demo wiring`,
		`\t\t/>\n\t{/if}`
	);

	// (2) フロント: アプリ側クライアント/アダプタ
	removeFile(`${APP}/src/lib/banto/attachmentsClient.ts`, 'attachmentsClient.ts 削除');
	removeFile(`${APP}/src/lib/banto/attachmentsAdmin.ts`, 'attachmentsAdmin.ts 削除');

	// (3) バックエンド: REST ルータ + items からの delete_for_record / 依存
	//   rest/mod.rs
	cutRegion(
		REST_MOD,
		'rest: Route table の attachments 行除去（doc）',
		'//! | POST   | `/api/attachments/list`',
		'//! | DELETE | `/api/attachments/{id}` | -              | 204 (editor+)           |'
	);
	drop(
		REST_MOD,
		'rest: banto_attachments use 除去',
		`use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment, MAX_ATTACHMENT_BYTES};\n`
	);
	drop(REST_MOD, 'rest: mod attachments 除去', `mod attachments;\n`);
	drop(REST_MOD, 'rest: use attachments_router 除去', `use attachments::attachments_router;\n`);
	cutRegion(
		REST_MOD,
		'rest: ATTACHMENT_BODY_LIMIT_SLACK_BYTES 除去',
		'/// Slack added on top of `banto_attachments::MAX_ATTACHMENT_BYTES` for',
		'const ATTACHMENT_BODY_LIMIT_SLACK_BYTES: usize = 1024 * 1024;'
	);
	drop(
		REST_MOD,
		'rest: Services 構造体の attachments フィールド除去',
		`    pub attachments: AttachmentsService,\n`
	);
	// api_router 冒頭の `let Services { … } = services;` destructure から
	// attachments を外す（M-13 で位置引数→構造体化）。backup と、コアなので
	// 残る system_info に挟んで一意指定する（8スペースの裸 `attachments,` を
	// より深いインデント行の部分文字列として拾わないため。lib.rs の AppState
	// リテラルと同じ配慮）。
	swapText(
		REST_MOD,
		'rest: api_router destructure の attachments 除去',
		`        backup,\n        attachments,\n        system_info,`,
		`        backup,\n        system_info,`
	);
	drop(
		REST_MOD,
		'rest: items_router への attachments 引数除去',
		`            attachments.clone(),\n`
	);
	drop(
		REST_MOD,
		'rest: attachments_router の合流除去',
		`        .merge(attachments_router(attachments, audit, auth.clone(), events))\n`
	);
	//   rest/items.rs（ItemsWriteState.attachments / 両 fn の引数 / delete_for_record）
	drop(
		REST_ITEMS,
		'rest/items: attachments フィールド/引数除去',
		`    attachments: AttachmentsService,\n`
	);
	drop(REST_ITEMS, 'rest/items: attachments 実引数除去', `        attachments,\n`);
	cutRegion(
		REST_ITEMS,
		'rest/items: items_delete の delete_for_record 除去',
		`    // M20 unit C demo wiring (attachments-plan §3.8): sweep up any attachments left`,
		`        (attachments_removed > 0).then(|| json!({ "attachmentsRemoved": attachments_removed }));`
	);
	swapText(
		REST_ITEMS,
		'rest/items: items_delete の detail を None に',
		`        Some(&id.to_string()),\n        detail,\n    )`,
		`        Some(&id.to_string()),\n        None,\n    )`
	);
	//   rest/tests.rs（cargo test 対象。api_router の attachments 引数除去に追随）
	removeAttachmentsFromRestTests();
	//   banto-serve.rs（AttachmentsService の構築 + api_router 実引数）
	drop(
		BANTO_SERVE,
		'banto-serve: AttachmentsService use 除去',
		`use banto_attachments::AttachmentsService;\n`
	);
	cutRegion(
		BANTO_SERVE,
		'banto-serve: AttachmentsService 構築除去',
		`    // M20 attachments (spec docs/design/attachments-plan.md §3.3): base_dir is the`,
		`    let attachments = AttachmentsService::new(db.clone(), attachments_base_dir);`
	);
	swapText(
		BANTO_SERVE,
		'banto-serve: Services リテラルから attachments 除去',
		`        backup,\n        attachments,\n        system_info,`,
		`        backup,\n        system_info,`
	);

	// (4) 依存: @banto/attachments + crates/banto-attachments を workspace から外す
	removeAppDep('@banto/attachments');
	drop(
		WS_CARGO,
		'workspace: members から banto-attachments 除去',
		`  "crates/banto-attachments",\n`
	);
	drop(
		WS_CARGO,
		'workspace: dependencies から banto-attachments 除去',
		`banto-attachments = { path = "crates/banto-attachments" }\n`
	);
	cutRegion(
		CORE_CARGO,
		'core: banto-attachments 依存除去',
		'# M20 attachments (spec docs/design/attachments-plan.md §3.1, unit B): `rest.rs`',
		'banto-attachments = { workspace = true }'
	);
	// postgres feature（V2 PR2）は banto-attachments/postgres を含む。依存を外した
	// 以上この参照も消さないと `feature includes banto-attachments/postgres, but
	// banto-attachments is not a dependency` で cargo が manifest 解析に失敗する。
	drop(
		CORE_CARGO,
		'core: postgres feature の banto-attachments 参照除去',
		`  "banto-attachments/postgres",\n`
	);
	cutRegion(
		TAURI_CARGO,
		'src-tauri: banto-attachments 依存除去',
		'# M20 attachments (spec docs/design/attachments-plan.md §3.1, unit B): `AppState`',
		'banto-attachments = { workspace = true }'
	);
	removeDir('crates/banto-attachments', 'crates/banto-attachments 削除');

	// (5) マイグレーション（他テーブルから参照されないため単独で外せる）。
	//     V2 で SQLite/Postgres の2系統に分かれたため両方から削除する。
	removeFile(
		`${APP}/core/migrations-sqlite/0006_attachments.sql`,
		'migrations-sqlite/0006_attachments.sql 削除'
	);
	removeFile(
		`${APP}/core/migrations-postgres/0006_attachments.sql`,
		'migrations-postgres/0006_attachments.sql 削除'
	);

	// (6) アーキテクチャ検査（pnpm verify:architecture）の attachments 参照を外す。
	//     rule 8 の DUAL_PATH/REST_READ/TAURI_READ/DESKTOP_ONLY と rule 9 の
	//     NewAttachment 検査（削除済みクレートを read するとクラッシュ）を除去。
	removeAttachmentsFromVerifyArch();

	// src-tauri lib.rs（非コンパイル・コードレビュー担保）
	removeAttachmentsFromLibRs();
}

/**
 * rest/tests.rs（`admin-template-core` の `cargo test` 対象）から attachments を外す。
 * `api_router` から attachments 引数が消えるのに追随しないと、削除済みクレート
 * `banto_attachments` を参照するテストがコンパイルできず `cargo test` が赤くなる。
 * 除去箇所は次のとおり（M20 ブロックは crate ごと消えるので丸ごと・他は false positive）:
 *   (a) M20 attachments テストブロック（独自の実サービス+tempdir）を章マーカー間で。
 *   (b) `unused_attachments_service` ヘルパ + doc コメント。
 *   (c) 各ルータビルダの `unused_attachments_service(...)` 宣言（6箇所）。
 *   (d) backup ヘルパ（M17 テストで生存）の実 `AttachmentsService::new(...)` 宣言。
 *   (e) 各ルータヘルパの `Services { … }` リテラルの `attachments,`（backup, と system_info, の間、全て8スペース）。
 * `PathBuf` import は `unused_backup_service` が使うため残す。
 */
function removeAttachmentsFromRestTests() {
	// (a) M20 テストブロックを章マーカー間で丸ごと削除（他の attachments, 参照より
	//     先に消すことで、残る api_router 実引数がビルダの分だけになる）。
	//     かつては `cutEnd`（マーカーから EOF まで）だったが、M20 章の**後ろ**に
	//     追記された章（Issue #189 の 閲覧公開スイート）まで巻き添えで消していた。
	//     終端マーカーを置いて範囲を閉じる（tests.rs の該当コメント参照）。
	cutRegion(
		REST_TESTS,
		'rest/tests: M20 attachments テストブロック除去',
		'\n\n// --- M20: attachments',
		'// Keep any new section strictly outside the pair.'
	);
	// (b) unused_attachments_service ヘルパ + doc コメント（直前の空行ごと）を除去。
	drop(
		REST_TESTS,
		'rest/tests: unused_attachments_service ヘルパ除去',
		`\n/// An \`AttachmentsService\` for router helpers that never exercise\n/// \`/api/attachments/*\` - same "never actually written to" reasoning as\n/// [\`unused_backup_service\`]. Tests that DO exercise attachments use\n/// [\`router_with_role_tokens_and_attachments\`] instead, which points at\n/// a real, writable temp directory.\nfn unused_attachments_service(db: banto_storage::Db) -> AttachmentsService {\n    AttachmentsService::new(db, PathBuf::from("unused-in-tests").join("attachments"))\n}\n`
	);
	// (c) ビルダの unused_attachments_service 宣言（6箇所を dropBlock が一括除去）。
	drop(
		REST_TESTS,
		'rest/tests: unused_attachments_service 宣言除去',
		`    let attachments = unused_attachments_service(pool.clone());\n`
	);
	// (d) backup ヘルパの実 AttachmentsService 宣言（M17 テストで生き残るヘルパ内）。
	drop(
		REST_TESTS,
		'rest/tests: backup ヘルパの実 attachments 宣言除去',
		`    let attachments = AttachmentsService::new(db.clone(), dir.path().join("attachments"));\n`
	);
	// (e) 各ルータヘルパの `Services { … }` リテラル（M-13 で位置引数→構造体化）から
	//     attachments フィールドを除去。全リテラルが 8スペース field 一段で揃うので、
	//     backup と（コアなので残る）system_info に挟んで前後行込みで一意指定する
	//     一つの swap で足りる（swap は全出現を置換）。深いインデント行の部分文字列
	//     として拾わないための前後行アンカーでもある。
	swapText(
		REST_TESTS,
		'rest/tests: Services リテラルから attachments 除去',
		`        backup,\n        attachments,\n        system_info,`,
		`        backup,\n        system_info,`
	);
}

/**
 * 帳票デモ（`@banto/report` + 日報デモ、M19）。remove-optional-assets.md「帳票デモ」。
 * DB/バックエンド配線を持たない最小デモなので、items ページの日報ボタン・
 * ルート/ライブラリ・@banto/report 依存 + print CSS だけで外せる。
 */
function removeReport() {
	swapText(
		ITEMS,
		'lucide から FileText 除去',
		`import { Download, FileText, Plus, Upload } from '@lucide/svelte';`,
		`import { Download, Plus, Upload } from '@lucide/svelte';`
	);
	cutRegion(
		ITEMS,
		'items ページの日報ボタン除去',
		`\t\t\t<!-- M19 report demo`,
		`\t\t\t\t{m['items.report']()}\n\t\t\t</button>`
	);
	removeDir(`${APP}/src/routes/(app)/items/report`, 'items/report ルート削除');
	removeDir(`${APP}/src/lib/banto/reports`, 'lib/banto/reports 削除');
	drop(
		APP_CSS,
		'app.css: @banto/report/print.css の @import 除去',
		`@import '@banto/report/print.css';\n`
	);
	cutRegion(
		APP_CSS,
		'app.css: 帳票用 @media print ブロック除去',
		`@media print {\n\tbody.banto-report-active`,
		`\tbody.banto-report-active .shell main {\n\t\tpadding: 0;\n\t}\n}`
	);
	removeAppDep('@banto/report');
}

// --- verify-architecture.mjs helper -----------------------------------------

function removeAttachmentsFromVerifyArch() {
	// rule 1: サービス層検査の対象ディレクトリ（削除済みでも walk は無害だが明示的に外す）
	drop(
		VERIFY_ARCH,
		'verify: 対象ディレクトリから banto-attachments/src 除去',
		`\t\t'crates/banto-attachments/src',\n`
	);
	// rule 8: 両経路対称マニフェストの attachments エントリ
	drop(
		VERIFY_ARCH,
		'verify: DUAL_PATH の attachments_upload 除去',
		`\t\t{ tauri: 'attachments_upload', rest: 'POST /api/attachments', role: 'Editor' },\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: DUAL_PATH の attachments_delete 除去',
		`\t\t{ tauri: 'attachments_delete', rest: 'DELETE /api/attachments/{id}', role: 'Editor' }\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: DESKTOP_ONLY の attachments_open_folder 除去',
		`\t\t'attachments_open_folder',\n`
	);
	drop(VERIFY_ARCH, 'verify: TAURI_READ の attachments_list 除去', `\t\t'attachments_list',\n`);
	drop(
		VERIFY_ARCH,
		'verify: TAURI_READ の attachments_read_body 除去',
		`\t\t'attachments_read_body',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: TAURI_READ の attachments_read_thumbnail 除去',
		`\t\t'attachments_read_thumbnail',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の attachments download 除去',
		`\t\t'GET /api/attachments/{id}/download',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の attachments thumbnail 除去',
		`\t\t'GET /api/attachments/{id}/thumbnail',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の attachments list 除去',
		`\t\t'POST /api/attachments/list'\n`
	);
	// rule 9: NewAttachment の mime 検査（削除済みクレートを read するのでブロックごと外す）
	cutRegion(
		VERIFY_ARCH,
		'verify: rule9 の NewAttachment mime 検査除去',
		'\t// A) `NewAttachment` は mime フィールドを持たない。',
		"'NewAttachment に mime フィールド — クライアント申告 MIME は受け取らない（§6、判定は detect_mime のマジックバイトのみ）'\n\t\t);"
	);
}

// --- src-tauri lib.rs helpers（非コンパイル・コードレビュー担保） -----------

function removeAttachmentsFromLibRs() {
	drop(
		LIB_RS,
		'lib.rs: banto_attachments use 除去',
		`use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment};\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: AppState の attachments/attachments_dir フィールド除去',
		`    /// File/image attachments (spec \`docs/design/attachments-plan.md\` §3, M20 unit`,
		`    attachments_dir: PathBuf,`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: items_delete の delete_for_record 除去',
		`    // M20 unit C demo wiring (spec docs/design/attachments-plan.md §3.8): sweep up`,
		`        .then(|| serde_json::json!({ "attachmentsRemoved": attachments_removed }));`
	);
	// items_delete は監査記録を `record_ok(…, Some(&id.to_string()), detail)` で書く
	// （M-1 で AuditEntry から record_ok へ集約）。attachments を外すと sweep が
	// 消え `detail` 変数が無くなるので、6番目の実引数 `detail` を `None` に差し替える。
	// rest/items.rs 側の同名 swap（record_write 呼び出し）と同形。
	swapText(
		LIB_RS,
		'lib.rs: items_delete の detail を None に',
		`        Some(&id.to_string()),\n        detail,\n    )`,
		`        Some(&id.to_string()),\n        None,\n    )`
	);
	drop(
		LIB_RS,
		'lib.rs: start_embedded_server の attachments 引数除去',
		`    attachments: AttachmentsService,\n`
	);
	// start_embedded_server 内 `let services = Services { … };` リテラルの
	// attachments フィールド（8スペースの裸 `attachments,`、M-13 で位置引数→構造体化）。
	// 16スペースの AppState リテラル行の部分文字列にならないよう前後行込みで指定する
	// （backup, と、コアなので残る system_info, の間）。
	swapText(
		LIB_RS,
		'lib.rs: Services リテラルから attachments 除去',
		`        backup,\n        attachments,\n        system_info,`,
		`        backup,\n        system_info,`
	);
	drop(
		LIB_RS,
		'lib.rs: server_apply の attachments 実引数除去',
		`                state.attachments.clone(),\n`
	);
	drop(
		LIB_RS,
		'lib.rs: setup の attachments 実引数除去',
		`                    attachments.clone(),\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: AppState 構築の attachments 除去',
		`            // M20 attachments (spec docs/design/attachments-plan.md §3.3): same`,
		`            let attachments = AttachmentsService::new(db.clone(), attachments_dir.clone());`
	);
	drop(
		LIB_RS,
		'lib.rs: AppState 構築リテラルの attachments/attachments_dir 除去',
		`                attachments,\n                attachments_dir,\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: attachments コマンド一式除去',
		`// --- M20: attachments --------------------------------------------------------`,
		`    #[cfg(not(target_os = "windows"))]\n    {\n        Ok(OpenFolderResult {\n            opened: false,\n            path,\n        })\n    }\n}`
	);
	drop(
		LIB_RS,
		'lib.rs: invoke_handler の attachments コマンド登録除去',
		`            attachments_list,\n            attachments_read_thumbnail,\n            attachments_read_body,\n            attachments_upload,\n            attachments_delete,\n            attachments_open_folder,\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: test app_state の attachments 除去',
		`            attachments: AttachmentsService::new(\n                pool,`,
		`            attachments_dir: PathBuf::from("unused-in-tests").join("attachments"),`
	);
	drop(
		LIB_RS,
		'lib.rs: test app_state_with_tempdir の attachments 除去',
		`            attachments: AttachmentsService::new(pool, dir.path().join("attachments")),\n            attachments_dir: dir.path().join("attachments"),\n`
	);
	// test の attachments コマンドテスト（M-5、upload/delete の _body を叩く2本）を
	// マーカーごと丸ごと除去。attachments_*_body は上の M20 コマンド cutRegion で
	// 消えるので、テスト側もここで消さないと未定義シンボル参照で cargo test が赤くなる。
	// マーカーは mod tests の閉じ括弧の手前にあるため、cutRegion（両端含む）で
	// モジュールの `}` は残る。
	cutRegion(
		LIB_RS,
		'lib.rs: test の M20 attachments コマンドテスト除去',
		`    // --- M20: attachments command tests -----------------------------------`,
		`    // --- end M20 attachments command tests ---------------------------------`
	);
}

function removeVibrancyFromLibRs() {
	cutRegion(
		LIB_RS,
		'lib.rs: vibrancy 型/ヘルパ/コマンド除去',
		`/// Settings key for the desktop vibrancy toggle (spec M12): a GLOBAL`,
		`    Ok(VibrancyStatus { enabled, supported })\n}`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: 起動時の vibrancy 再適用除去',
		`            // M12: re-apply the persisted vibrancy (Windows Acrylic) choice`,
		`                            "banto: メインウィンドウが見つからないため、起動時のAcrylic効果の適用をスキップしました"\n                        ),\n                    }\n                }\n            }`
	);
	drop(
		LIB_RS,
		'lib.rs: invoke_handler の vibrancy コマンド登録除去',
		`            vibrancy_apply,\n            vibrancy_status,\n`
	);
}

function removeWindowVibrancyDeps() {
	cutRegion(
		WS_CARGO,
		'workspace: window-vibrancy 依存除去',
		'# Desktop-only (spec M12 Glass theme): real window translucency (Windows',
		'window-vibrancy = "0.8"'
	);
	cutRegion(
		TAURI_CARGO,
		'src-tauri: window-vibrancy 依存除去',
		'# Real window translucency for the glass theme (spec M12): Windows Acrylic',
		'window-vibrancy = { workspace = true }'
	);
}

// removeGlass の src-tauri 部分を差し込む（上の関数定義後に本体を確定）。
function removeGlassSrcTauri() {
	removeVibrancyFromLibRs();
	removeWindowVibrancyDeps();
}

// --- tree（ツリービュー・デモ、M-review 2026-08）----------------------------
//
// docs/recipes/remove-optional-assets.md「ツリーデモ」手順 1〜4 の 1 対 1 自動化。
// DB/バックエンド配線を持たない最小デモなので、フロントのみで完結する。
// packages/tree-svelte 本体は同梱のまま（他 remover と同方針: パッケージは
// 残しても他に影響しない）。

function removeTree() {
	// (1) デモルートとサンプルデータ
	removeDir(`${APP}/src/routes/(app)/tree`, 'tree デモルート削除');
	removeFile(`${APP}/src/lib/banto/treeSample.ts`, 'treeSample.ts 削除');

	// (2) ナビゲーション（union とアイコンマップは型で連結しているため対で外す）
	//     union は「自分の1語だけ」を drop する — 同じ行を後続の remover
	//     （display の items / adminPages / dashboard）も縮めるので、行全体を
	//     アンカーにすると再実行が壊れる。
	drop(NAV, 'nav: NavIconKey union から tree 除去', `'tree' | `);
	drop(NAV, 'nav: NavLabelKey union から nav.tree 除去', `'nav.tree' | `);
	drop(
		NAV,
		'nav: navItems の /tree 行除去',
		`\t{ path: '/tree', labelKey: 'nav.tree', icon: 'tree' },\n`
	);
	drop(NAV_ICONS, 'navIcons: ListTree import 除去', `ListTree, `);
	drop(NAV_ICONS, 'navIcons: tree エントリ除去', `\ttree: ListTree,\n`);

	// (3) i18n ブリッジ（treeMessages はファイル末尾の章なので EOF まで削除）と文言キー
	drop(
		I18N,
		'i18n: TreeMessages import 除去',
		`import type { TreeMessages } from '@banto/tree-svelte';\n`
	);
	cutEnd(I18N, 'i18n: treeMessages() 除去', '/**\n * `@banto/tree-svelte` `messages` prop:');
	cutRegion(
		`${APP}/messages/ja.json`,
		'messages/ja: nav.tree + tree.* キー除去',
		`,\n  "nav.tree": "ツリービュー"`,
		`"tree.demo.none": "（なし）"`
	);
	cutRegion(
		`${APP}/messages/en.json`,
		'messages/en: nav.tree + tree.* キー除去',
		`,\n  "nav.tree": "Tree view"`,
		`"tree.demo.none": "(none)"`
	);

	// (4) 依存
	removeAppDep('@banto/tree-svelte');
	// tree-svelte も .svelte.ts を持つので optimizeDeps.exclude（issue #150 / ADR-0007）
	// に載っている。exclude の末尾は @banto/ui（常に残る）なので tree-svelte は末尾要素では
	// なく、行ごと外せる（trailingComma:none のまま prettier 準拠が保たれる）。
	drop(VITE, 'vite: optimizeDeps.exclude から tree-svelte 除去', `\t\t\t'@banto/tree-svelte',\n`);
}

// --- items（デモリソース一式、display プリセット専用）------------------------
//
// docs/design/display-preset-plan.md §3.2 / template-scope §3。items は長らく「コア」
// 扱いだったが、実体は**差し替え前提のデモリソース**なので display で
// 丸ごと外せるように再分類した（docs/recipes/add-resource.md「items の関与ファイル
// 全量（層別）」の表と1対1）。
//
// 実装方針: 巨大な items 区画には PR-D1 が `// [scaffold:items] begin/end`
// マーカーを入れてある（Rust 3ファイル + src-tauri + フロント 2ファイル）ので、
// ここは `cutMarked` をマーカーの出現順に呼ぶだけ。マーカーの無い小さな参照
// （import 1行・union 1語・マニフェスト行）だけ drop/swap で個別に外す。
//
// **順序の前提**: ORDER で attachments より後に走る。attachments remover が
// rest/mod.rs・src-tauri・verify-architecture の attachments 行を先に外して
// いることを前提にしたアンカー（DESKTOP_ONLY の末尾整形）が1箇所ある。
// display は必ず attachments も外すので、この前提は常に成立する。

function removeItems() {
	// (1) Rust: サービス層 + REST ルータ + マイグレーション
	removeFile(`${APP}/core/src/items.rs`, 'core/items.rs 削除');
	removeFile(REST_ITEMS, 'core/rest/items.rs 削除');
	removeFile(
		`${APP}/core/migrations-sqlite/0001_items.sql`,
		'migrations-sqlite/0001_items.sql 削除'
	);
	removeFile(
		`${APP}/core/migrations-postgres/0001_items.sql`,
		'migrations-postgres/0001_items.sql 削除'
	);
	cutMarked(CORE_LIB, 'core/lib.rs: pub mod items 除去', 'items');

	// db.rs: 列0のマーカー2つ（SEED_ROW_COUNT / デモ seed 生成一式）と
	// インデント4のマーカー2つ（seed 呼び出し / seed テスト）を出現順に。
	cutMarked(CORE_DB, 'db.rs: SEED_ROW_COUNT 除去', 'items');
	cutMarked(CORE_DB, 'db.rs: デモ seed 生成一式除去', 'items');
	cutMarked(CORE_DB, 'db.rs: run_migrations_and_seed の seed 呼び出し除去', 'items', '    ');
	cutMarked(CORE_DB, 'db.rs: デモ seed テスト除去', 'items', '    ');

	// rest/mod.rs: 列0が4つ（Route table doc 行 / use crate::items / mod items /
	// use items_router）、インデント4が1つ（Services のフィールド）、
	// インデント8が2つ（destructure / merge）。
	cutMarked(REST_MOD, 'rest: Route table の items 行除去（doc）', 'items');
	cutMarked(REST_MOD, 'rest: use crate::items 除去', 'items');
	cutMarked(REST_MOD, 'rest: mod items 除去', 'items');
	cutMarked(REST_MOD, 'rest: use items_router 除去', 'items');
	cutMarked(REST_MOD, 'rest: Services の items フィールド除去', 'items', '    ');
	cutMarked(REST_MOD, 'rest: api_router destructure の items 除去', 'items', '        ');
	cutMarked(REST_MOD, 'rest: items_router の合流除去', 'items', '        ');
	removeItemsFromRestModImports();

	// rest/tests.rs: 列0が3つ（items テスト本体 / M14 の items ステップ /
	// 閲覧公開の items シナリオ）、インデント4が1つ（setup テストの
	// 「ガード済みルート」確認）。共有ヘルパの items 宣言と `Services` リテラルは
	// マーカー外なので drop/swap で外す。
	// `rest/tests.rs` は `use super::*;` で mod.rs の import を借りている。
	// `removeItemsFromRestModImports()` がそこを絞るので、テストだけが使う
	// `StatusCode` / `ListParams` / `Role` はここで直接 import に移す（同時に、
	// items 一覧テスト専用だったフィルタ/ソート型の import を落とす）。
	swapText(
		REST_TESTS,
		'rest/tests: テスト専用 import を直接 import に移す',
		`use axum::http::Request as HttpRequest;\nuse banto_core::{BantoError, FilterOp, FilterState, Pagination, SortDirection, SortState};`,
		`use axum::http::{Request as HttpRequest, StatusCode};\nuse banto_core::{BantoError, ListParams};\nuse crate::users::Role;`
	);
	cutMarked(REST_TESTS, 'rest/tests: items テストブロック除去', 'items');
	cutMarked(REST_TESTS, 'rest/tests: setup テストの items ガード確認除去', 'items', '    ');
	cutMarked(REST_TESTS, 'rest/tests: M14 の items 監査ステップ除去', 'items');
	cutMarked(REST_TESTS, 'rest/tests: 閲覧公開の items シナリオ除去', 'items');
	drop(
		REST_TESTS,
		'rest/tests: ルータヘルパの ItemsService 宣言除去（pool）',
		`    let items = ItemsService::new(pool.clone()).with_events(tx.clone());\n`
	);
	drop(
		REST_TESTS,
		'rest/tests: ルータヘルパの ItemsService 宣言除去（db）',
		`    let items = ItemsService::new(db.clone()).with_events(tx.clone());\n`
	);
	// `Services { … }` リテラルの先頭フィールド。直前行ごと指定して、より深い
	// インデントの `items,` を部分文字列として拾わないようにする（attachments
	// remover の同型 swap と同じ配慮）。
	swapText(
		REST_TESTS,
		'rest/tests: Services リテラルから items 除去',
		`Services {\n        items,\n`,
		`Services {\n`
	);

	// banto-serve.rs（LAN 配信バイナリ。マーカー不要な3行）
	drop(
		BANTO_SERVE,
		'banto-serve: ItemsService use 除去',
		`use admin_template_core::items::ItemsService;\n`
	);
	drop(
		BANTO_SERVE,
		'banto-serve: ItemsService 構築除去',
		`    let items = ItemsService::new(db.clone()).with_events(events.clone());\n`
	);
	swapText(
		BANTO_SERVE,
		'banto-serve: Services リテラルから items 除去',
		`let services = Services {\n        items,\n`,
		`let services = Services {\n`
	);

	// (2) src-tauri（非コンパイル・コードレビュー担保）
	removeItemsFromLibRs();

	// (3) フロント: ルート・リソース定義・デモデータ・ナビ
	removeDir(`${APP}/src/routes/(app)/items`, 'items ルート一式削除');
	removeFile(`${APP}/src/lib/banto/itemsAdmin.ts`, 'itemsAdmin.ts 削除');
	removeFile(`${APP}/src/lib/banto/resources/items.ts`, 'resources/items.ts 削除');
	removeFile(`${APP}/src/lib/banto/sampleData.ts`, 'sampleData.ts 削除');
	// dashboard.ts は丸ごと items 集計（ファイル冒頭の D1-d メモ参照）。charts/dock
	// remover が先に `@banto/charts` 参照を外しているので、ここで消して問題ない。
	removeFile(DASH_LIB, 'dashboard.ts（items 集計）削除');

	cutMarked(RESOURCES_INDEX, 'resources: itemsResource import 除去', 'items');
	swapText(
		RESOURCES_INDEX,
		'resources: 登録配列を空に',
		`// D1-d note (display-preset-plan.md, Issue #190 prep): the future \`items\`\n// remover needs a \`swapText\` here, not a \`cutRegion\` delete - \`resources\`\n// must still be a valid (possibly empty) array afterwards:\n//   \`[itemsResource]\` -> \`[]\`\nexport const resources: ResourceDefinition[] = [itemsResource];`,
		`export const resources: ResourceDefinition[] = [];`
	);
	drop(SETUP_TS, 'setup: sampleItems import 除去', `import { sampleItems } from './sampleData';\n`);
	swapText(
		SETUP_TS,
		'setup: デモ provider の items シード除去',
		`createInMemoryDataProvider({ items: { rows: sampleItems } })`,
		`createInMemoryDataProvider({})`
	);
	swapText(
		SETUP_TS,
		'setup: doc コメントの items 参照を更新',
		` * - \`resources/items.ts\` + \`resources/index.ts\` — resource definitions and\n *   registration (**the files you replace**, docs/recipes/add-resource.md)`,
		` * - \`resources/index.ts\` — resource definitions and registration\n *   (docs/recipes/add-resource.md。display プリセットは items デモを外した\n *   空配列から始まる)`
	);

	// union の縮小は「自分の1語だけ」を落とす形にする（他の remover の編集結果に
	// 依存しない = `--dry-run`（＝書き込まないので連鎖しない）でも計画が出せる）。
	cutMarked(NAV, 'nav: navItems の /items 行除去', 'items', '\t');
	drop(NAV, 'nav: NavIconKey union から items 除去', `'items' | `);
	drop(NAV, 'nav: NavLabelKey union から nav.items 除去', `'nav.items' | `);
	drop(NAV_ICONS, 'navIcons: Package import 除去', `Package, `);
	drop(NAV_ICONS, 'navIcons: items エントリ除去', `\titems: Package,\n`);
	// grid の空状態だけ items 辞書を借りていた（パッケージ既定の日本語に戻す）。
	drop(
		I18N,
		'i18n: grid emptyState の items キー参照除去',
		`\t\temptyState: () => m['items.list.empty'](),\n`
	);
	for (const [file, label] of [
		[MSG_JA, 'messages/ja'],
		[MSG_EN, 'messages/en']
	])
		removeMessageKeys(file, `${label}: items.* / nav.items キー除去`, ['items', 'nav.items']);

	// (4) アーキテクチャ検査のマニフェスト（rule 8）
	removeItemsFromVerifyArch();

	// (5) e2e（display は items/users を叩くシナリオが全滅するので組み替える）
	replaceE2eForDisplay();
}

/**
 * `rest/mod.rs` の共有 import を、items（と先に外れた attachments）が消えた
 * 後の実使用に合わせて絞る。`rest/{items,attachments}.rs` が `use super::*;`
 * で借りていた分が丸ごと不要になるため、放置すると unused_imports 警告が
 * 大量に出る（`cargo clippy -- -D warnings` を回す派生アプリで赤になる）。
 */
function removeItemsFromRestModImports() {
	drop(REST_MOD, 'rest: axum::body::Bytes import 除去', `use axum::body::Bytes;\n`);
	drop(REST_MOD, 'rest: axum::extract import 除去', `use axum::extract::{Path, Query, State};\n`);
	drop(REST_MOD, 'rest: axum::http import 除去', `use axum::http::{HeaderMap, StatusCode};\n`);
	drop(REST_MOD, 'rest: axum::response::Response import 除去', `use axum::response::Response;\n`);
	drop(REST_MOD, 'rest: axum::routing import 除去', `use axum::routing::{get, post};\n`);
	swapText(
		REST_MOD,
		'rest: axum::Json import 除去',
		`use axum::{Json, Router};`,
		`use axum::Router;`
	);
	drop(
		REST_MOD,
		'rest: banto_core import 除去',
		`use banto_core::{BantoError, ListParams, ListResult};\n`
	);
	swapText(
		REST_MOD,
		'rest: banto_server::routes の items/attachments 専用ヘルパ除去',
		`use banto_server::routes::{\n    actor_identity, audit_log_router, audit_logout_middleware, backups_router, extra_auth_router,\n    record_write, require_role_at_least, system_info_router, ui_settings_router, users_router,\n    LogoutAuditState, MetricsProbe, RoleGuard,\n};`,
		`use banto_server::routes::{\n    audit_log_router, audit_logout_middleware, backups_router, extra_auth_router,\n    system_info_router, ui_settings_router, users_router, LogoutAuditState, MetricsProbe,\n};`
	);
	swapText(
		REST_MOD,
		'rest: banto_server の require_auth/ApiError 除去',
		`use banto_server::{\n    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,\n    GrantRegistry, GrantSpec, ServerEvent,\n};`,
		`use banto_server::{\n    auth_routes, require_banto_client_header, sse_route, AuthState, GrantRegistry, GrantSpec,\n    ServerEvent,\n};`
	);
	drop(REST_MOD, 'rest: serde::Deserialize import 除去', `use serde::Deserialize;\n`);
	drop(REST_MOD, 'rest: serde_json::json import 除去', `use serde_json::json;\n`);
	drop(
		REST_MOD,
		'rest: AuditEntry import 除去',
		`use crate::audit::{AuditEntry, AuditLogService};\n`
	);
	editFile(REST_MOD, 'rest: AuditLogService import を再追加', (s) =>
		s.includes('use crate::audit::AuditLogService;')
			? null
			: s.includes('use crate::backup::BackupService;')
				? s.replace(
						'use crate::backup::BackupService;',
						'use crate::audit::AuditLogService;\nuse crate::backup::BackupService;'
					)
				: undefined
	);
	swapText(
		REST_MOD,
		'rest: users の Role import 除去',
		`use crate::users::{Role, UsersService};`,
		`use crate::users::UsersService;`
	);
}

/** `src-tauri/src/lib.rs` の items 区画（マーカー15箇所）を出現順に外す。 */
function removeItemsFromLibRs() {
	// 列0（3）: use・items_* コマンド群・items_export_csv_to_folder
	cutMarked(LIB_RS, 'lib.rs: items use 除去', 'items');
	cutMarked(LIB_RS, 'lib.rs: items_* コマンド群除去', 'items');
	cutMarked(LIB_RS, 'lib.rs: items_export_csv_to_folder 除去', 'items');
	// インデント4（4）: AppState フィールド・start_embedded_server 引数・
	//                   M15 テスト章・items_delete 監査テスト
	cutMarked(LIB_RS, 'lib.rs: AppState の items フィールド除去', 'items', '    ');
	cutMarked(LIB_RS, 'lib.rs: start_embedded_server の items 引数除去', 'items', '    ');
	cutMarked(LIB_RS, 'lib.rs: test の M15 CSV import 章除去', 'items', '    ');
	cutMarked(LIB_RS, 'lib.rs: test の items_delete 監査テスト除去', 'items', '    ');
	// インデント8（1）: start_embedded_server の Services リテラル
	cutMarked(LIB_RS, 'lib.rs: Services リテラルから items 除去', 'items', '        ');
	// インデント12（4）: setup の ItemsService 構築・invoke_handler 登録・
	//                    test app_state / app_state_with_tempdir
	cutMarked(LIB_RS, 'lib.rs: setup の ItemsService 構築除去', 'items', '            ');
	cutMarked(LIB_RS, 'lib.rs: invoke_handler の items コマンド登録除去', 'items', '            ');
	cutMarked(LIB_RS, 'lib.rs: test app_state の items 除去', 'items', '            ');
	cutMarked(LIB_RS, 'lib.rs: test app_state_with_tempdir の items 除去', 'items', '            ');
	// インデント16（2）: server_apply の実引数・AppState 構築リテラル
	cutMarked(LIB_RS, 'lib.rs: server_apply の items 実引数除去', 'items', '                ');
	cutMarked(LIB_RS, 'lib.rs: AppState 構築リテラルの items 除去', 'items', '                ');
	// インデント20（1）: setup の start_embedded_server 実引数
	cutMarked(LIB_RS, 'lib.rs: setup の items 実引数除去', 'items', '                    ');
}

/** `verify:architecture` rule 8 のマニフェストから items のエントリを外す。 */
function removeItemsFromVerifyArch() {
	drop(
		VERIFY_ARCH,
		'verify: DUAL_PATH の items 4対除去',
		`\t\t{ tauri: 'items_create', rest: 'POST /api/items', role: 'Editor' },\n` +
			`\t\t{ tauri: 'items_update', rest: 'PUT /api/items/{id}', role: 'Editor' },\n` +
			`\t\t{ tauri: 'items_delete', rest: 'DELETE /api/items/{id}', role: 'Editor' },\n` +
			`\t\t{ tauri: 'items_import', rest: 'POST /api/items/import', role: 'Editor' },\n`
	);
	// DESKTOP_ONLY の**末尾要素**（カンマ無し）なので、直前の行のカンマごと外して
	// trailingComma:none を保つ（prettier 準拠）。前の行が何かに依存しない形。
	editFile(VERIFY_ARCH, 'verify: DESKTOP_ONLY の items_export_csv_to_folder 除去', (s) => {
		const withComma = `,\n\t\t'items_export_csv_to_folder'\n`;
		if (s.includes(withComma)) return s.replace(withComma, '\n');
		if (!s.includes(`'items_export_csv_to_folder'`)) return null; // 適用済み
		return undefined; // 末尾要素でなくなった＝構造が変わった
	});
	drop(
		VERIFY_ARCH,
		'verify: TAURI_READ の items_get/items_list 除去',
		`\t\t'items_get',\n\t\t'items_list',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の GET /api/items/{id} 除去',
		`\t\t'GET /api/items/{id}',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の POST /api/items/list 除去',
		`\t\t'POST /api/items/list',\n`
	);
}

/**
 * e2e を display 向けに組み替える。
 *
 * 同梱の3スイートはいずれも items / users 画面（とダッシュボード）を前提に
 * している: `tests/smoke.spec.ts`（items CRUD/CSV/添付/ユーザー管理）、
 * `tests-public-viewer/`（`/items` の読み取り専用確認）、`visual/`（items /
 * users / dashboard のスクリーンショットと axe-core）。display ではその画面が
 * 存在しないので、**1シナリオのスモークだけを残す**:
 *   「まっさらな DB で未ログインの `/` が `/monitor` に着く」
 * ＝ 初回起動シード（viewer_public）+ 合成 viewer + `/monitor` の結線確認。
 * ビジュアル回帰はベースライン画像ごと外す（派生アプリが自分の画面で
 * 撮り直すもので、テンプレートの画像を引き継ぐ意味が無い）。
 */
function replaceE2eForDisplay() {
	copyTemplateOver(
		'display/smoke.spec.ts',
		E2E_SMOKE,
		'e2e: スモークを display の1シナリオに差し替え'
	);
	removeDir('e2e/tests-public-viewer', 'e2e: 閲覧公開スイート削除');
	removeDir('e2e/visual', 'e2e: ビジュアル回帰 + axe-core スイート削除');
	removeFile('.github/workflows/visual-baselines.yml', 'CI: visual-baselines ワークフロー削除');

	// playwright.config.ts: 先頭の doc コメントを display 版に差し替える
	// （3スイート前提の説明が丸ごと嘘になるため）。
	editFile(PLAYWRIGHT_CONFIG, 'playwright: 先頭の doc コメントを display 版に', (s) => {
		const NEW_DOC =
			`/**\n` +
			` * Playwright config（display プリセット）。\n` +
			` *\n` +
			` * project は \`chromium\`（testDir \`./tests\`）の1つだけ。テンプレート同梱の\n` +
			` * \`public-viewer\` / \`visual\` スイートは items・users・ダッシュボードの画面を\n` +
			` * 前提にしていたため display では外してある（\`scripts/scaffold.mjs\`）。\n` +
			` *\n` +
			` * \`webServer\` は \`banto-serve --features embed-ui\` を**直接**起動する\n` +
			` * （\`cargo run\` ではない）。実行前に次の2つを済ませておくこと:\n` +
			` *   pnpm --filter admin-template build\n` +
			` *   cargo build -p admin-template-core --bin banto-serve --features embed-ui\n` +
			` *\n` +
			` * DB は毎回まっさらな一時ディレクトリに作る。display のスモークは\n` +
			` * 「初回起動シードが効いて未ログインでも \`/monitor\` に着く」ことを見るので、\n` +
			` * 前回の残骸を再利用すると前提が崩れる。\n` +
			` */\n`;
		if (s.startsWith(NEW_DOC)) return null;
		const end = s.indexOf(' */\n');
		if (!s.startsWith(`/**\n * Playwright config for Banto's E2E suites`) || end === -1)
			return undefined;
		return NEW_DOC + s.slice(end + ' */\n'.length);
	});
	swapText(
		PLAYWRIGHT_CONFIG,
		'playwright: chromium project のコメントを整理',
		`\t\t// M18 smoke suite (unchanged behavior): explicit testDir so adding the\n\t\t// \`visual\` project below can never pull tests/visual/*.spec.ts into the\n\t\t// wrong project or vice versa.\n`,
		`\t\t// display スモーク（1シナリオ）。\n`
	);

	// playwright.config.ts: project 2つ（public-viewer / visual）と、その
	// webServer エントリ（2つ目の banto-serve / vite preview）を、**直前の
	// カンマごと**まとめて外す（残る要素が配列の末尾になるので trailingComma:none
	// を保つ）。どちらも「残す要素の直後 … 配列の最後の要素の終わり」の1領域。
	cutRegion(
		PLAYWRIGHT_CONFIG,
		'playwright: public-viewer / visual project 除去',
		`,\n\t\t// Viewer-public mode (Issue #189)`,
		`toHaveScreenshot: { animations: 'disabled', maxDiffPixels: 250 }\n\t\t\t}\n\t\t}`
	);
	cutRegion(
		PLAYWRIGHT_CONFIG,
		'playwright: 2つ目の banto-serve / vite preview webServer 除去',
		`,\n\t\t{\n\t\t\t// Second banto-serve for the \`public-viewer\` project`,
		`\t\t\tstdout: 'pipe'\n\t\t}`
	);
	cutRegion(
		PLAYWRIGHT_CONFIG,
		'playwright: public-viewer 用の定数/DB パス除去',
		`// \`public-viewer\` project (viewer-public-plan.md §3.1-8, Issue #189)`,
		`const PUBLIC_VIEWER_BASE_URL = \`http://127.0.0.1:\${PUBLIC_VIEWER_PORT}\`;\n\n`
	);
	cutRegion(
		PLAYWRIGHT_CONFIG,
		'playwright: visual 用の定数除去',
		`// \`visual\` project (browser demo mode, vite preview`,
		`const VISUAL_BASE_URL = \`http://127.0.0.1:\${VISUAL_PORT}\`;\n\n`
	);
	cutRegion(
		PLAYWRIGHT_CONFIG,
		'playwright: public-viewer 用 DB パス除去',
		`// Same temp dir (one teardown removes both), separate file`,
		`const publicViewerDbPath = path.join(dbDir, 'banto-e2e-public-viewer.sqlite3');\n`
	);

	// ルート package.json のスクリプトと ci.yml のステップ
	drop(
		ROOT_PKG,
		'root package.json: e2e:visual スクリプト除去',
		`    "e2e:visual": "playwright test --config=e2e/playwright.config.ts --project=visual",\n`
	);
	drop(
		ROOT_PKG,
		'root package.json: e2e:public-viewer スクリプト除去',
		`    "e2e:public-viewer": "playwright test --config=e2e/playwright.config.ts --project=public-viewer",\n`
	);
	cutRegion(
		CI_WORKFLOW,
		'ci: 閲覧公開 e2e ステップ除去',
		`      # Viewer-public mode (Issue #189)`,
		`        run: pnpm e2e:public-viewer\n\n`
	);
	cutRegion(
		CI_WORKFLOW,
		'ci: ビジュアル回帰 + axe-core ステップ除去',
		`      # Baselines under e2e/visual/**/*-snapshots`,
		`        run: pnpm e2e:visual\n\n`
	);
}

// --- adminPages（users / audit-log の「画面」だけ外す）----------------------
//
// display-preset-plan.md §3.2。**サービス層 / REST / Tauri コマンドは残す** —
// 表示専用アプリでもユーザー管理・監査ログの機能自体は裏に必要（LAN で誰かが
// ログインして設定を変える導線）で、画面を戻したくなったらルートを足すだけで
// 済む escape hatch を保つため。`auditLogAdmin.ts` は設定画面（監査ログの保持
// ポリシー）が使い続けるので残し、`usersAdmin.ts` は参照元が消えるので外す。

function removeAdminPages() {
	removeDir(`${APP}/src/routes/(app)/users`, 'users 画面削除');
	removeDir(`${APP}/src/routes/(app)/audit-log`, 'audit-log 画面削除');
	removeFile(`${APP}/src/lib/banto/usersAdmin.ts`, 'usersAdmin.ts 削除（参照元なし）');

	drop(
		NAV,
		'nav: navItems の /users 行除去',
		`\t{ path: '/users', labelKey: 'nav.users', icon: 'users', adminOnly: true },\n`
	);
	drop(
		NAV,
		'nav: navItems の /audit-log 行除去',
		`\t{ path: '/audit-log', labelKey: 'nav.auditLog', icon: 'audit-log', adminOnly: true },\n`
	);
	drop(NAV, 'nav: NavIconKey union から users/audit-log 除去', `'users' | 'audit-log' | `);
	drop(
		NAV,
		'nav: NavLabelKey union から nav.users/nav.auditLog 除去',
		`'nav.users' | 'nav.auditLog' | `
	);
	drop(NAV_ICONS, 'navIcons: Users/ScrollText import 除去', `Users, ScrollText, `);
	drop(NAV_ICONS, 'navIcons: users エントリ除去', `\tusers: Users,\n`);
	drop(NAV_ICONS, 'navIcons: audit-log エントリ除去', `\t'audit-log': ScrollText,\n`);

	// 文言キー。`audit.*` は設定画面（保持ポリシーの表示）が 4 キーだけ使い
	// 続けるので、それらを除いて外す。
	const KEEP_AUDIT = [
		'audit.retentionDaysValue',
		'audit.retentionRowsValue',
		'audit.retentionRowsUnlimited',
		'audit.retentionUnlimited'
	];
	for (const [file, label] of [
		[MSG_JA, 'messages/ja'],
		[MSG_EN, 'messages/en']
	])
		removeMessageKeys(
			file,
			`${label}: users.* / audit.*（設定画面が使う4キーを除く）/ nav キー除去`,
			['users', 'audit', 'nav.users', 'nav.auditLog'],
			KEEP_AUDIT
		);
}

// --- dashboard（/dashboard を外し、ホームを /monitor に向ける）--------------
//
// display-preset-plan.md §3.3: dock / charts / items 集計を失ったダッシュボードを
// 残す価値が無いので、ページごと外して `/monitor` をホームにする。
// `/monitor` の実体（ナビ項目・ページ・文言）は次の `applyDisplayDefaults()` が
// 足す — ここは「外す」と「リダイレクト先の付け替え」だけ。

function removeDashboard() {
	removeDir(`${APP}/src/routes/(app)/dashboard`, 'dashboard 画面削除');
	swapText(
		ROOT_PAGE_TS,
		'routes/+page.ts: ルートのリダイレクト先を /monitor に',
		`// The root path only dispatches: guests to /login, users to /dashboard\n// (the (app) layout guard handles the auth check).\nexport function load(): never {\n\tredirect(307, resolve(\`dashboard\`));\n}`,
		`// The root path only dispatches: guests to /login, users to /monitor\n// (the (app) layout guard handles the auth check).\nexport function load(): never {\n\tredirect(307, resolve(\`monitor\`));\n}`
	);
	// login ページの goto は全箇所とも同じ式（swap は全出現を置換する）。
	// kit 3 の `resolve()` はルート ID で型付けされるので、`monitor` は
	// `applyDisplayDefaults()` が置く `(app)/monitor` が在って初めて型が通る
	// （check は display の全工程を適用した後に走る）。
	swapText(
		LOGIN,
		'login: ログイン後の遷移先を /monitor に',
		`goto(resolve(\`dashboard\`))`,
		`goto(resolve(\`monitor\`))`
	);
	for (const [file, label] of [
		[MSG_JA, 'messages/ja'],
		[MSG_EN, 'messages/en']
	])
		removeMessageKeys(file, `${label}: dashboard.* / panels.* キー除去`, ['dashboard', 'panels']);
}

// --- display の「足す」工程 --------------------------------------------------
//
// 冒頭 doc のとおり、ここが scaffold 唯一の additions。足すのは2種類だけ:
//   (a) **テンプレート本体に既にあるトグルの既定値の反転**
//       （`FIRST_BOOT_SETTINGS` / `KIOSK_DEFAULT` / `banto.i18n`）。
//   (b) **`scripts/lib/templates/display/` の雛形の複製**（`/monitor` ページ）
//       と、それを繋ぐ最小の配線（ナビ1行 + 文言キー1つ）。
// 出力にしか無いロジックは作らない（plan §2 原則 1）。冪等性・`--strict` の
// 扱いは removers と同じ（`swap` は「置換後の値が在る＝適用済み」、`addFile` は
// 「同内容で既存＝適用済み」）。

function applyDisplayDefaults() {
	// (a) 既定値の反転 -------------------------------------------------------
	// 初回起動シード（`settings` テーブルが空のときだけ書かれる。D1-a）。
	// キー文字列は crates/banto-admin-services/src/settings.rs の
	// KEY_* 定数と一致させること。
	swapText(
		FIRST_BOOT,
		'first_boot: FIRST_BOOT_SETTINGS に display の既定を設定',
		`pub const FIRST_BOOT_SETTINGS: &[(&str, &str)] = &[];`,
		`pub const FIRST_BOOT_SETTINGS: &[(&str, &str)] = &[\n` +
			`    ("auth.disabled", "true"),\n` +
			`    ("auth.disabled_role", "admin"),\n` +
			`    ("server.viewer_public", "true"),\n` +
			`    ("server.enabled", "true"),\n` +
			`    ("server.bind", "0.0.0.0"),\n` +
			`];`
	);
	// 空 const 前提のユニットテストを、新しい既定を検証する形に置き換える。
	swapText(
		FIRST_BOOT,
		'first_boot: 既定シードのテストを display 版に',
		`    async fn seed_first_boot_settings_is_a_no_op_with_todays_empty_const() {\n` +
			`        let settings = service().await;\n` +
			`        let wrote = seed_first_boot_settings(&settings).await.unwrap();\n` +
			`        assert!(!wrote);\n` +
			`    }`,
		`    async fn seed_first_boot_settings_writes_the_display_defaults() {\n` +
			`        let settings = service().await;\n` +
			`        let wrote = seed_first_boot_settings(&settings).await.unwrap();\n` +
			`        assert!(wrote);\n` +
			`        assert_eq!(\n` +
			`            settings.get("server.viewer_public").await.unwrap(),\n` +
			`            Some("true".to_string())\n` +
			`        );\n` +
			`    }`
	);
	// キオスクシェル（D1-b。サイドバー折り畳み既定 + ヘッダのコンパクト化 +
	// 全画面ボタン）。
	swapText(
		SETTINGS_STORE,
		'settings: KIOSK_DEFAULT を true に',
		`export const KIOSK_DEFAULT = false;`,
		`export const KIOSK_DEFAULT = true;`
	);
	// i18n opt-out（D1-c。conventions §13）。`raw-jp-in-app` と
	// `check-i18n-nonempty` が自身をスキップする。
	swapText(APP_PKG, 'package.json: banto.i18n を raw に', `"i18n": "keys"`, `"i18n": "raw"`);

	// (b) /monitor -----------------------------------------------------------
	copyTemplate(
		'display/monitor/+page.svelte',
		`${APP}/src/routes/(app)/monitor/+page.svelte`,
		'monitor ページ配置'
	);
	// ナビは dashboard 行を置き換える（アイコンキーも dashboard → monitor に
	// 改名して LayoutDashboard を流用する）。`publicViewer: true` が
	// `(app)/+layout.ts` のガードの着地点（＝合成 viewer のホーム）になる。
	swapText(
		NAV,
		'nav: /dashboard 行を /monitor に置換',
		`\t{ path: '/dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', publicViewer: true },\n`,
		`\t{ path: '/monitor', labelKey: 'nav.monitor', icon: 'monitor', publicViewer: true },\n`
	);
	swapText(
		NAV,
		'nav: NavIconKey union を monitor に',
		`NavIconKey = 'dashboard' | `,
		`NavIconKey = 'monitor' | `
	);
	swapText(
		NAV,
		'nav: NavLabelKey union を nav.monitor に',
		`\n\t'nav.dashboard' | `,
		`\n\t'nav.monitor' | `
	);
	swapText(
		NAV,
		'nav: publicViewer の doc コメントを更新',
		`\t * public-viewer session. Template default: \`/dashboard\` and \`/items\`.`,
		`\t * public-viewer session. display preset default: \`/monitor\` only.`
	);
	swapText(
		NAV_ICONS,
		'navIcons: dashboard エントリを monitor に改名',
		`\tdashboard: LayoutDashboard,\n`,
		`\tmonitor: LayoutDashboard,\n`
	);
	// 文言キーは1つだけ足す（`banto.i18n = "raw"` でもナビのラベルは Paraglide
	// 経由のまま = サイドバー/ページタイトルの解決経路を変えない）。
	addMessageKey(MSG_JA, 'messages/ja: nav.monitor 追加', 'nav.settings', 'nav.monitor', 'モニター');
	addMessageKey(MSG_EN, 'messages/en: nav.monitor 追加', 'nav.settings', 'nav.monitor', 'Monitor');
}

// --- 実行 -------------------------------------------------------------------

// --- banto 本体専用のもの（全プリセット共通で除去、#271） --------------------
//
// 外部利用 fixture（fixtures/external-consumer/）と、それを流すワークフロー・
// ref 書き換えスクリプト。banto 本体のリリース検証（docs/upgrading.md §8.2）に
// しか使わない。verify-architecture の rule `external-consumer-fixture` は
// fixture が無ければ対象外としてスキップする。
function removeBantoReleaseOnly() {
	removeDir('fixtures/external-consumer', '外部利用 fixture 削除（banto 本体専用）');
	removeFile(
		'.github/workflows/external-consumer.yml',
		'external-consumer ワークフロー削除（banto 本体専用）'
	);
	removeFile(
		'scripts/external-fixture-set-ref.mjs',
		'fixture の ref 書き換えスクリプト削除（banto 本体専用）'
	);
	removeFile(
		'scripts/external-fixture-set-ref.test.mjs',
		'fixture の ref 書き換えスクリプトのテスト削除（banto 本体専用）'
	);
}

const REMOVERS = {
	charts: removeCharts,
	dock: removeDock,
	glass: () => {
		removeGlass();
		removeGlassSrcTauri();
	},
	commandPalette: removeCommandPalette,
	attachments: removeAttachments,
	report: removeReport,
	tree: removeTree,
	// display 専用（PRESETS.display からのみ選ばれる）。
	items: removeItems,
	adminPages: removeAdminPages,
	dashboard: removeDashboard,
	displayDefaults: applyDisplayDefaults
};

// 前半（オプション資産）は remove-optional-assets.md の資産並び順。remover 間はテキスト領域が
// 独立なので順序非依存。
//
// 後半（display 専用）は**順序依存**なので、この並びを崩さないこと:
//   - `items` は attachments / report / tree より後（それらが items のファイル
//     やマニフェスト行を先に触るアンカーを持つ）。
//   - `adminPages` / `dashboard` は `items` より後（navigation.ts の union を
//     順番に縮めていくため）。
//   - `displayDefaults` は最後（縮み切った union に /monitor を足す）。
const ORDER = [
	'charts',
	'dock',
	'glass',
	'commandPalette',
	'attachments',
	'report',
	'tree',
	'items',
	'adminPages',
	'dashboard',
	'displayDefaults'
];

/**
 * 各工程の「適用済みか」を判定する印（template-edit.mjs の `beginStep`）。
 * **その工程自身が消すファイル/ディレクトリ**を選ぶ（消さないものを選ぶと
 * 2 回目の適用も初回適用と判定されて落ちる。scaffold.test.mjs の再実行テスト）。
 * 印がまだ在れば初回適用で、削除パターン（drop / cutRegion / cutEnd /
 * removeMessageKeys）が見つからなければ失敗にする。印が既に無ければ再実行で、
 * 見つからない＝適用済み。印は工程の開始時に 1 度だけ見るので、工程の途中で
 * 消してもその工程の判定は変わらない。
 *
 * displayDefaults は「足す」工程で削除系の編集を持たない（swap / addFile /
 * addMessageKey だけで書く）ので印は `null`。印が `null` の工程で削除系を呼ぶと
 * editRemoval が投げる（共通工程の bantoReleaseOnly も同じ）。足す工程に
 * 削除系が要るようになったら、その工程が消す印をここに足すこと。
 */
const STEP_MARKERS = {
	charts: `${APP}/src/lib/components/DashboardPanel.svelte`,
	dock: `${APP}/src/lib/banto/panels.ts`,
	glass: 'packages/theme/src/css/banto-glass.css',
	commandPalette: `${APP}/src/lib/components/CommandPalette.svelte`,
	attachments: 'crates/banto-attachments',
	report: `${APP}/src/lib/banto/reports`,
	tree: `${APP}/src/lib/banto/treeSample.ts`,
	items: `${APP}/core/src/items.rs`,
	adminPages: `${APP}/src/lib/banto/usersAdmin.ts`,
	dashboard: `${APP}/src/routes/(app)/dashboard`,
	displayDefaults: null
};

/** `--interactive` の custom モードで個別トグルできる資産（オプション資産だけ）。 */
const CUSTOM_TOGGLEABLE = OPTIONAL_ASSETS;

/** ORDER のうち「足す」工程（削除ではない）。表示を分けるためだけの集合。 */
const ADDITIONS = new Set(['displayDefaults']);

/** 選択内容を「削除 … / 追加 …」の1〜2行にまとめる（--dry-run と本適用で共用）。 */
function describeSelection(toRemove) {
	const picked = ORDER.filter((a) => toRemove.has(a));
	if (picked.length === 0) return '削除する資産: なし（full 相当。検証のみ）';
	const removed = picked.filter((a) => !ADDITIONS.has(a));
	const added = picked.filter((a) => ADDITIONS.has(a));
	const lines = [];
	if (removed.length > 0) lines.push(`削除する資産: ${removed.join(', ')}`);
	if (added.length > 0)
		lines.push(`足す工程: ${added.join(', ')}（既定値の反転 + /monitor の雛形）`);
	return lines.join('\n');
}

// --- 対話モード（--interactive/-i）-----------------------------------------
//
// ここで作るのは `toRemove`（削除する資産の Set）だけ。それ以降は --preset と
// 完全に同じ削除ループ・report・次のステップ表示を共有する（plan §7.3 の
// 「対話は入力を作るだけ、削除ロジックは単一」という要件）。

const PRESET_DESCRIPTIONS = {
	minimal: 'コアのみ（charts/dock/Glass/コマンドパレット/添付/帳票/ツリーを全削除）',
	standard: 'dock+charts+パレット+Glass 同梱（添付・帳票・ツリーを削除）',
	full: '全オプション同梱（何も削除しない）',
	display:
		'表示専用（minimal + items デモ/users・audit-log 画面/ダッシュボードを削除、' +
		'/monitor・初回起動シード・キオスク・i18n raw を追加）'
};

/**
 * readline インターフェースを 1 行ずつ読む `ask()` を作る。
 *
 * 注意: `rl.question()`（readline/promises 標準 API）は使わない。pipe された
 * 非 TTY stdin では「複数行が 1 チャンクで届く」→ readline が 'line' イベントを
 * 同期的に連続発火 → 2 問目以降の `question()` がリスナー登録前に流れた
 * 'line' を取りこぼして**永久に停止する**、という既知の挙動があるため
 * （このスクリプトの手動検証で再現・確認済み）。async イテレータ
 * （`rl[Symbol.asyncIterator]()`）はキューイングされるためこの問題が無く、
 * TTY・pipe どちらでも同じコードで安全に動く。モジュールは引き続き
 * `node:readline/promises` のみ（新規依存なし、conventions §3）。
 * 入力が尽きた（EOF）場合は `null` を返す。
 */
function makeAsk(rl) {
	const lines = rl[Symbol.asyncIterator]();
	return async function ask(query) {
		process.stdout.write(query);
		const { value, done } = await lines.next();
		return done ? null : value;
	};
}

/** EOF（入力が尽きた）を明示的な失敗として扱う。 */
function failOnEof(value) {
	if (value === null)
		fail('対話入力が途中で終了しました（EOF）。パイプ入力の行数を確認してください');
	return value;
}

async function promptPreset(ask) {
	console.log(
		'どのプリセットを適用しますか？\n' +
			`  1) minimal  … ${PRESET_DESCRIPTIONS.minimal}\n` +
			`  2) standard … ${PRESET_DESCRIPTIONS.standard}\n` +
			`  3) full     … ${PRESET_DESCRIPTIONS.full}\n` +
			`  4) display  … ${PRESET_DESCRIPTIONS.display}\n` +
			`  5) custom   … オプション資産（${CUSTOM_TOGGLEABLE.length}種）を個別に選ぶ\n` +
			'              ※ custom で選べるのはオプション資産だけです。display の\n' +
			'                items/画面削除・追加は一括適用なので 4) を選んでください'
	);
	const byNumber = { 1: 'minimal', 2: 'standard', 3: 'full', 4: 'display', 5: 'custom' };
	const byName = new Set(['minimal', 'standard', 'full', 'display', 'custom']);
	for (;;) {
		const answer = failOnEof(await ask('番号または名前を入力してください [1-5]: ')).trim();
		if (byNumber[answer]) return byNumber[answer];
		if (byName.has(answer)) return answer;
		console.log(`入力が正しくありません: ${answer}`);
	}
}

/** [Y/n]（デフォルト Yes）を読む。空入力/y/yes は true、n/no は false。 */
async function promptYesDefaultYes(ask, question) {
	for (;;) {
		const answer = failOnEof(await ask(`${question} [Y/n]: `))
			.trim()
			.toLowerCase();
		if (answer === '' || answer === 'y' || answer === 'yes') return true;
		if (answer === 'n' || answer === 'no') return false;
		console.log(`入力が正しくありません: ${answer}`);
	}
}

/** [y/N]（デフォルト No）を読む。空入力/n/no は false、y/yes は true。 */
async function promptYesDefaultNo(ask, question) {
	for (;;) {
		const answer = failOnEof(await ask(`${question} [y/N]: `))
			.trim()
			.toLowerCase();
		if (answer === '' || answer === 'n' || answer === 'no') return false;
		if (answer === 'y' || answer === 'yes') return true;
		console.log(`入力が正しくありません: ${answer}`);
	}
}

async function promptCustomToRemove(ask) {
	const toRemove = new Set();
	console.log('オプション資産ごとに残す/削除を選んでください（Enter で既定＝残す）:');
	for (const asset of CUSTOM_TOGGLEABLE) {
		const keep = await promptYesDefaultYes(ask, `  ${asset} を残しますか?`);
		if (!keep) toRemove.add(asset);
	}
	return toRemove;
}

/**
 * 対話フロー全体（プリセット選択 → 必要なら custom → 確認）を一つの
 * readline インターフェースで進める。pipe された stdin でも取りこぼしが
 * 起きないよう、途中で `createInterface` を作り直さない（`makeAsk` 参照）。
 * `--dry-run` のときは確認を省き、そのまま toRemove を返す（既存の
 * dry-run 経路＝変更を書かない、をそのまま通す）。
 */
async function resolveInteractive() {
	if (!process.stdin.isTTY) {
		// pipe された stdin でも行単位で読めるのでそのまま動くが、TTY が無い
		// 環境（CI 等）では対話の意図が伝わりにくいので一言添える。
		console.log(
			'（標準入力がターミナルではありません。パイプ入力で対話に応答します。\n' +
				'  自動化する場合は --preset を使ってください。）'
		);
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = makeAsk(rl);
	try {
		const choice = await promptPreset(ask);
		const toRemove =
			choice === 'custom' ? await promptCustomToRemove(ask) : new Set(PRESETS[choice]);

		console.log(describeSelection(toRemove));

		if (args.dryRun) return toRemove;

		const confirmed = await promptYesDefaultNo(ask, '適用しますか?');
		if (!confirmed) {
			console.log('中止しました（変更はありません）。');
			process.exit(0);
		}
		return toRemove;
	} finally {
		rl.close();
	}
}

async function main() {
	const toRemove = args.preset ? new Set(PRESETS[args.preset]) : await resolveInteractive();

	console.log(
		`${args.preset ? `プリセット '${args.preset}' を適用` : '選択した内容を適用'}${args.dryRun ? '（--dry-run: 変更しません）' : ''}\n` +
			`${describeSelection(toRemove)
				.split('\n')
				.map((line) => `  ${line}`)
				.join('\n')}\n`
	);

	// 資産の選択とは独立に、全プリセット共通で最初に走らせる。
	console.log('# bantoReleaseOnly');
	beginStep(null);
	removeBantoReleaseOnly();

	for (const asset of ORDER) {
		if (!toRemove.has(asset)) continue;
		console.log(`# ${asset}`);
		beginStep(STEP_MARKERS[asset]);
		REMOVERS[asset]();
	}

	if (editor.report(args.dryRun ? '\n--dry-run: 以下を適用します\n' : '\n適用しました\n')) {
		process.exit(1);
	}

	// 内部用（verify-architecture の scaffold-acceptance-paths）。触ったパスを機械可読で
	// 出す。`--dry-run` 専用で、通常の出力・挙動は変えない。
	if (args.listTouched) {
		for (const rel of [...editor.touched].sort()) console.log(`TOUCHED ${rel}`);
		for (const rel of [...editor.removed].sort()) console.log(`REMOVED ${rel}`);
		process.exit(0);
	}

	console.log(`
次のステップ:
  1. pnpm install（削除した依存の反映）
  2. 検証: pnpm --filter admin-template check / build / cargo check
  ${toRemove.size === 0 ? '' : '3. 削除で不活性になった未使用 CSS セレクタ等は警告として残ることがあります（ビルドは緑）。\n  '}注: src-tauri（lib.rs / Cargo）はこのサンドボックスではコンパイルできないため、
  そのコード整合はコードレビューで担保します（docs/conventions.md）。attachments の
  除去は apps/admin-template/core/src/rest/tests.rs にも及ぶため、全プリセットで
  \`cargo test -p admin-template-core\` は緑を維持します。${
		toRemove.has('displayDefaults')
			? `

display の既定（docs/design/display-preset-plan.md §3.2）:
  - 初回起動シード: auth.disabled / auth.disabled_role=admin / server.viewer_public /
    server.enabled / server.bind=0.0.0.0 を、settings テーブルが空のときだけ書き込む
    （apps/admin-template/core/src/first_boot.rs で調整できます）
  - キオスクシェル既定 ON（設定画面「外観」で戻せます）
  - package.json の banto.i18n = "raw"（UI 文言の直書きを許可。conventions §13）
  - ホームは /monitor（src/routes/(app)/monitor/+page.svelte を書き換えて使います）
  - e2e はシナリオ1本のスモークのみ。ビジュアル回帰スイートは外れています`
			: ''
	}`);
}

await main();
