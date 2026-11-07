#!/usr/bin/env node
/**
 * アーキテクチャ規約の機械検査（improvement-plan-2026-07.md P3-5）。
 * docs/conventions.md のうち「機械で検査可能な不変条件」を CI で強制する。
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリのみ。
 *
 * 検査する規約（違反 = exit 1。各ルールの根拠は conventions.md の該当節）:
 *   1. §2 サービス層は tauri/axum を知らない
 *      … core/src（rest/ と bin/ を除く）と banto-{core,storage,attachments}
 *        に `use axum` / `use tauri` がないこと
 *   2. §4 パッケージ間 import ゼロ … packages/星/src に `from '@banto/...'` がない
 *   3. §5 パッケージはアプリ固有 import を持たない … 同上に `$lib` / `#lib`
 *      （SvelteKit 3 の subpath imports）からの import がない
 *      加えて素の import 指定子（相対パスでも `svelte`・`svelte/*` でもないもの）が
 *      無いこと（rule `package-bare-imports`、ADR-0018 §5）。依存を宣言できない
 *      （empty-deps）のに `@lucide/svelte` 等を import すると、モノレポでは
 *      admin-template の依存が巻き上げで見えて通り、依存を持たない派生アプリでだけ
 *      壊れる。`$app/`・`@tauri-apps/`・`#lib` もここで落ちる。コメントは除いて検査
 *   4. §7 {@html} は許可リストの2箇所のみ
 *   5. §9 コンポーネント CSS に生の色値を書かない
 *      … packages（theme を除く）の .svelte <style> ブロックに hex/rgb()/hsl()
 *        がない（コメントは除去してから検査。許可リストは理由付きで下記）
 *   6. §4 パッケージの dependencies / peerDependencies は空
 *   7. ドキュメント整合性: docs/・README・AGENTS・CLAUDE の `@banto/*` 参照が
 *      実在パッケージのみ（conventions の不変条件ではなくドキュメントと実装の
 *      ドリフト対策。実在しない `@banto/grid-core` 等の掲載を防ぐ）
 *   8. §1 REST/Tauri 両経路対称 … mutating 操作が両経路に存在するかを
 *      DUAL_PATH マニフェスト + 完全性チェックで担保（片側だけ足すのを捕捉）。
 *      maintainability-review-2026-07.md CR-1
 *   9. §6 セキュリティ不変条件（grep 可能なもの、CR-2）:
 *      NewAttachment に mime フィールド無し / settings_get·set は Admin 対称
 *  10. §13 app 層コンポーネントに生の日本語リテラルが無い
 *      … apps/admin-template/src の .svelte（生成物 paraglide/ を除く）に
 *        コメント外の語構成日本語（ひらがな/カタカナ/CJK）が無いこと
 *  11. §11 マイグレーション方言のファイル名対称 … migrations-{sqlite,postgres}/
 *      のファイル名/連番が1対1（片系統だけ足すと該当 backend で静かに欠落）。
 *      中身の型差は §11 の意図的分岐でレビュー担保。ADR-0008
 *  12. §6 CSP 2定義のディレクティブ単位一致 … security_headers.rs の const と
 *      tauri.conf.json の app.security.csp が connect-src の IPC 差分を除き一致。
 *      ADR-0008
 *  13. 外部利用 fixture（fixtures/external-consumer/、#271）の対象の漏れ …
 *      packages/ のうち .svelte.ts を持つもの ⊆ fixture の dependencies ∩
 *      +page.svelte の import、fixture の optimizeDeps.exclude = その集合、
 *      crates/ の全 crate = fixture の rust/Cargo.toml の banto の Git 依存、
 *      npm と Cargo の ref が 1 つに揃っていること、fixture の Vite／Svelte 系の
 *      範囲指定が apps/admin-template/package.json と文字列で一致すること
 *  14. scaffold が編集するファイル（全プリセットの `--dry-run --list-touched`）⊆
 *      template-acceptance.yml の push / pull_request 両方の paths の glob。
 *      足し忘れると受け入れ CI が走らず、アンカー切れが静かに潜伏する。ADR-0008
 *
 * 許可リストへの追加は「設計判断としてコード内コメントで正当化されている」
 * ことを条件とし、理由をここに1行で書く（レビュー対象）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readI18nMode } from './lib/i18n-mode.mjs';
import { collectScaffoldTouchedFiles } from './lib/scaffold-touched.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** conventions §7: {@html} を書いてよいファイル（全エスケープ済み出力のみ）。 */
const HTML_ALLOWLIST = new Set([
	// 自前エンジン renderHtml の出力のみ（html.ts が全 text/attribute をエスケープ）
	'packages/report/src/ReportView.svelte',
	// qrcode クレート生成の SVG（LAN 接続 QR と到達確認の URL の QR。後者も LanReachCheckPanel へ渡す snippet としてこのファイルで描く）。settings-split refactor で
	// +page.svelte から ConnectivitySection.svelte へ移動（choiapp-feedback-2026-09 §3）。
	'apps/admin-template/src/routes/(app)/settings/ConnectivitySection.svelte'
]);

/** conventions §9: 生の色値を許可するファイルと、その根拠。 */
const RAW_COLOR_ALLOWLIST = new Map([
	// 印刷 CSS はテーマ非依存の白地・黒文字固定（帳票の再現性優先、
	// template-scope §3 / report-plan §3.4）
	['packages/report/src/ReportView.svelte', new Set(['#ffffff'])]
]);

/**
 * conventions §13: app 層コンポーネントに生の日本語リテラルを許可するファイル
 * と、その根拠。文言はキー経由（Paraglide messages）で持つのが原則で、例外は
 * 「設計判断としてコード内コメントで正当化されている」ことを条件に追加する。
 * 現状なし。
 */
const RAW_JP_ALLOWLIST = new Set([]);

let failures = 0;
const results = [];

function fail(rule, file, detail) {
	failures++;
	results.push(`  ✗ [${rule}] ${file}${detail ? ` — ${detail}` : ''}`);
}

function pass(rule, summary) {
	results.push(`  ✔ [${rule}] ${summary}`);
}

/** D1-c (display-preset-plan.md, Issue #190 prep): opt-out スキップの報告。 */
function skip(rule, reason) {
	results.push(`  − [${rule}] スキップ（${reason}）`);
}

function* walk(dir, exts) {
	const abs = path.join(repoRoot, dir);
	if (!fs.existsSync(abs)) return;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
			yield* walk(rel, exts);
		} else if (exts.some((ext) => entry.name.endsWith(ext))) {
			yield rel.split(path.sep).join('/');
		}
	}
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// --- 1. サービス層は tauri/axum を知らない（conventions §2） ----------------

{
	const rule = 'service-layer';
	let checked = 0;
	const dirs = [
		'apps/admin-template/core/src',
		'crates/banto-core/src',
		'crates/banto-storage/src',
		'crates/banto-admin-services/src'
	];
	for (const dir of dirs) {
		for (const file of walk(dir, ['.rs'])) {
			// rest/ は REST の wiring 層（axum を使うのが仕事）、bin/ はサーバ起動。
			if (file.includes('/rest/') || file.includes('/bin/')) continue;
			checked++;
			const src = read(file);
			const match = src.match(/^\s*use (axum|tauri)\b/m);
			if (match) fail(rule, file, `\`use ${match[1]}\` はサービス層に持ち込まない`);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `サービス層 ${checked} ファイルに axum/tauri 依存なし`);
}

// --- 2+3. パッケージの import 検査（conventions §4 / §5） --------------------

{
	let checked = 0;
	for (const file of walk('packages', ['.ts', '.svelte'])) {
		if (!file.includes('/src/')) continue;
		checked++;
		const src = read(file);
		if (/from\s+['"]@banto\//.test(src))
			fail('no-cross-package', file, 'パッケージ間 import は禁止（§4）');
		// `$lib` は SvelteKit 2 まで、`#lib` は SvelteKit 3 の subpath imports（#325）。
		// `import x from` / `import '...'` / `import('...')` のどれでも捕まえる。
		if (/\b(?:from|import)\s*\(?\s*['"](?:\$lib|#lib)['"/]/.test(src))
			fail('no-app-import', file, 'アプリ固有 import は禁止（§5）— client 注入にする');
	}
	if (!results.some((r) => r.includes('[no-cross-package]')))
		pass('no-cross-package', `packages ${checked} ファイルに @banto/* import なし`);
	if (!results.some((r) => r.includes('[no-app-import]')))
		pass('no-app-import', `packages に $lib / #lib import なし`);
}

// --- 2b. パッケージの素の import は svelte だけ（ADR-0018 §5） ---------------

/**
 * ソースから import 指定子を取り出す。コメント（ブロック・行・HTML）は
 * 先に除く。`from '…'`（import/export）・副作用 `import '…'`・動的 `import('…')` を拾う。
 * 行コメントは行頭か空白の直後の `//` だけを対象にし、`'https://…'` のような文字列は壊さない。
 */
function importSpecifiers(src) {
	const code = src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|\s)\/\/[^\n]*/g, '$1');
	const specs = [];
	for (const m of code.matchAll(
		/(?:(?<![\w@$.'"])from\s*|(?<![\w@$.])import\s*\(?\s*)['"]([^'"\n]+)['"]/g
	))
		specs.push(m[1]);
	return specs;
}

/** 許可: 相対パス、`svelte`、`svelte/*`。 */
const isAllowedPackageImport = (spec) =>
	spec.startsWith('./') ||
	spec.startsWith('../') ||
	spec === 'svelte' ||
	spec.startsWith('svelte/');

{
	const rule = 'package-bare-imports';
	// 対策の対策: 規則が実際に違反を捕まえる／コメントを無視することを毎回確かめる
	// （正規表現が黙って空振りして「違反ゼロ」になるのを防ぐ）。
	const bad = importSpecifiers(
		[
			"import { Inbox } from '@lucide/svelte';",
			"import '$app/navigation';",
			"const t = await import('@tauri-apps/api/core');",
			"export { x } from '#lib/foo';"
		].join('\n')
	).filter((spec) => !isAllowedPackageImport(spec));
	const ok = importSpecifiers(
		[
			"import type { Snippet } from 'svelte';",
			"import { tick } from 'svelte/internal';",
			"import x from './x.svelte';",
			"// import { Inbox } from '@lucide/svelte';",
			"/* import y from '$app/state'; */",
			'<!-- import z from "@tauri-apps/api"; -->',
			'const u = "https://example.com/a";'
		].join('\n')
	).filter((spec) => !isAllowedPackageImport(spec));
	if (bad.length !== 4 || ok.length !== 0)
		fail(
			rule,
			'scripts/verify-architecture.mjs',
			`自己検査に失敗（違反サンプル ${bad.length}/4 件検出、無害サンプル ${ok.length}/0 件誤検出）— importSpecifiers を見直す`
		);

	let checked = 0;
	for (const file of walk('packages', ['.ts', '.svelte'])) {
		if (!file.includes('/src/')) continue;
		checked++;
		for (const spec of importSpecifiers(read(file))) {
			if (isAllowedPackageImport(spec)) continue;
			fail(
				rule,
				file,
				`素の import \`${spec}\` — packages/*/src は \`svelte\`・\`svelte/*\`・相対パスしか import できない（依存は空、ADR-0018 §5）`
			);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `packages ${checked} ファイルの素の import は svelte / svelte/* のみ`);
}

// --- 4. {@html} 許可リスト（conventions §7） ---------------------------------

{
	const rule = 'html-allowlist';
	let found = 0;
	for (const dir of ['packages', 'apps/admin-template/src']) {
		for (const file of walk(dir, ['.svelte'])) {
			if (!read(file).includes('{@html')) continue;
			found++;
			if (!HTML_ALLOWLIST.has(file))
				fail(
					rule,
					file,
					'{@html} の新規使用 — conventions §7 の条件を満たすならこのスクリプトの許可リストへ理由付きで追加'
				);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `{@html} は許可済み ${found} 箇所のみ`);
}

// --- 5. 生の色値（conventions §9。theme パッケージは集約先なので対象外） ----

{
	const rule = 'raw-colors';
	let checkedBlocks = 0;
	for (const file of walk('packages', ['.svelte'])) {
		if (!file.includes('/src/') || file.startsWith('packages/theme/')) continue;
		const src = read(file);
		const allowed = RAW_COLOR_ALLOWLIST.get(file) ?? new Set();
		for (const block of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
			checkedBlocks++;
			const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
			for (const hit of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)) {
				if (allowed.has(hit[0])) continue;
				fail(rule, file, `生の色値 \`${hit[0]}\` — --banto-* トークンを使う（§9）`);
			}
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `package コンポーネント ${checkedBlocks} <style> ブロックに未許可の生色値なし`);
}

// --- 6. パッケージの依存は空（conventions §4） -------------------------------

{
	const rule = 'empty-deps';
	for (const dir of fs.readdirSync(path.join(repoRoot, 'packages'))) {
		const rel = `packages/${dir}/package.json`;
		if (!fs.existsSync(path.join(repoRoot, rel))) continue;
		const pkg = JSON.parse(read(rel));
		for (const field of ['dependencies', 'peerDependencies']) {
			if (pkg[field] && Object.keys(pkg[field]).length > 0)
				fail(rule, rel, `${field} は空であること（§4）: ${Object.keys(pkg[field]).join(', ')}`);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, '全パッケージの dependencies/peerDependencies が空');
}

// --- 7. docs 内の @banto/* 参照は実在パッケージのみ（ドキュメント整合性） ----

{
	const rule = 'docs-package-refs';
	// 実在パッケージ名は packages/*/package.json から動的取得（追加/改名に自動追従）。
	const realPackages = new Set();
	for (const dir of fs.readdirSync(path.join(repoRoot, 'packages'))) {
		const rel = `packages/${dir}/package.json`;
		if (!fs.existsSync(path.join(repoRoot, rel))) continue;
		realPackages.add(JSON.parse(read(rel)).name);
	}
	// 「存在しないパッケージ」を意図的にスコープ付きで名指しする場合のみ許可（理由付き）。
	// 作らないと決めた grid-core/dock-core はスコープ無しで書くこと。
	const DOCS_PACKAGE_REF_ALLOWLIST = new Set([]);
	const docFiles = [
		'README.md',
		'README.en.md',
		'AGENTS.md',
		'CLAUDE.md',
		...walk('docs', ['.md'])
	];
	let checkedRefs = 0;
	for (const file of docFiles) {
		if (!fs.existsSync(path.join(repoRoot, file))) continue;
		const src = read(file);
		for (const m of src.matchAll(/@banto\/[a-z0-9-]+/g)) {
			const ref = m[0];
			checkedRefs++;
			if (realPackages.has(ref) || DOCS_PACKAGE_REF_ALLOWLIST.has(ref)) continue;
			fail(
				rule,
				file,
				`実在しないパッケージ参照 \`${ref}\` — packages/ に無い。存在しないことを述べたいならスコープ無し（例: \`grid-core\`）で書くか、意図的なら許可リストへ理由付きで追加`
			);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `docs/README/AGENTS/CLAUDE の @banto/* 参照 ${checkedRefs} 件すべて実在`);
}

// --- 8. REST/Tauri 両経路対称（conventions §1、maintainability-review CR-1） ---
//
// このテンプレートの背骨の不変条件（§1）: mutating 操作は REST 経路と Tauri
// 経路の両方で同一の認可・監査を通す。AI が「片方の経路にだけ mutating
// コマンドを足す」ミスをしても、従来は落ちる検査が一つも無かった（しかも
// src-tauri はこのサンドボックスでコンパイルできず実行でも気づけない）。
//
// 自動対応は不可（REST ハンドラ名と Tauri コマンド名は食い違い、mutating でも
// desktop-only が多数、POST でも *_list は読み取り）。そこで下の DUAL_PATH
// マニフェストで対応を明示し、**完全性チェック**で自己強制する: 新しい
// コマンド/ルートを分類に足さない限り CI が落ちる → 片側追加を必ず捕捉する。
//
// アンカーは信頼できる2つの一次情報のみ:
//   - Tauri: src-tauri/src/lib.rs のトップレベル `#[tauri::command] fn 名`
//   - REST : rest/mod.rs モジュール doc の「Route table」（§1 が対応表と
//            指定する成果物。実ルート宣言との同期は下の doc-sync で担保）
//
// 分類はリポジトリ所有者が確認済み（maintainability-review-2026-07.md §3、
// 2026-07-21）。desktop-only / read の判断を変えるときはここを更新する。
{
	const rule = 'two-path-symmetry';

	// mutating な dual-path 操作: REST と Tauri の両方に存在しなければならない。
	// rest は "METHOD /path"（クエリ文字列は除く）。backups の復元系は経路が
	// 非対称（Tauri は stage→再起動適用、REST は from-upload/from-existing）
	// なので、2つの REST ルートを同一 Tauri コマンドに対応させる（所有者確認済み）。
	// `role` は期待するロール床（CR-6, 2026-07-22）。宣言した対だけロール床の
	// 対称も照合する（下記 (e)）。auth 系（公開 / 認証のみで resource ロール床が
	// 無い）は role を付けず、存在チェックのみ対象にする。
	const DUAL_PATH = [
		{ tauri: 'auth_setup', rest: 'POST /api/auth/setup' },
		{ tauri: 'auth_login', rest: 'POST /api/auth/login' },
		{ tauri: 'auth_logout', rest: 'POST /api/auth/logout' },
		{ tauri: 'auth_change_password', rest: 'POST /api/auth/change-password' },
		{ tauri: 'users_create', rest: 'POST /api/users', role: 'Admin' },
		{ tauri: 'users_update', rest: 'PUT /api/users/{id}', role: 'Admin' },
		{ tauri: 'users_delete', rest: 'DELETE /api/users/{id}', role: 'Admin' },
		{ tauri: 'users_reset_password', rest: 'POST /api/users/{id}/reset-password', role: 'Admin' },
		{ tauri: 'ui_settings_set', rest: 'PUT /api/ui-settings/{key}', role: 'Viewer' },
		{ tauri: 'audit_config_apply', rest: 'PUT /api/audit-log/config', role: 'Admin' },
		{ tauri: 'backups_create', rest: 'POST /api/backups', role: 'Admin' },
		{ tauri: 'backups_stage_restore', rest: 'POST /api/backups/restore', role: 'Admin' },
		{ tauri: 'backups_stage_restore', rest: 'POST /api/backups/{fileName}/restore', role: 'Admin' },
		{ tauri: 'backups_cancel_restore', rest: 'DELETE /api/backups/pending-restore', role: 'Admin' },
		// banto-cost P2（ADR-0028）: 能力の付与と案件メンバーの割当はシステム管理（admin）。
		{
			tauri: 'authz_capabilities_set',
			rest: 'PUT /api/users/{id}/capabilities',
			role: 'Admin'
		},
		{
			tauri: 'project_members_add',
			rest: 'PUT /api/projects/{id}/members/{userId}/{kind}',
			role: 'Admin'
		},
		{
			tauri: 'project_members_remove',
			rest: 'DELETE /api/projects/{id}/members/{userId}/{kind}',
			role: 'Admin'
		},
		// banto-cost P3a: 業務の書き込みは editor 床。その先の能力×案件範囲は
		// 両経路とも AuthzService::authorize_audited が判定する（ADR-0028）。
		{ tauri: 'customers_create', rest: 'POST /api/customers', role: 'Editor' },
		{ tauri: 'customers_update', rest: 'PUT /api/customers/{id}', role: 'Editor' },
		{ tauri: 'projects_create', rest: 'POST /api/projects', role: 'Editor' },
		{ tauri: 'projects_update', rest: 'PUT /api/projects/{id}', role: 'Editor' },
		{
			tauri: 'pipeline_versions_create',
			rest: 'POST /api/projects/{id}/pipeline-versions',
			role: 'Editor'
		},
		{
			tauri: 'pipeline_versions_adopt',
			rest: 'POST /api/projects/{id}/pipeline-versions/{versionId}/adopt',
			role: 'Editor'
		},
		// banto-cost P3b: 受注・売上・見通しの書き込みも editor 床＋authorize_audited。
		{ tauri: 'order_convert', rest: 'POST /api/projects/{id}/order/convert', role: 'Editor' },
		{
			tauri: 'order_change_create',
			rest: 'POST /api/projects/{id}/order/changes',
			role: 'Editor'
		},
		{
			tauri: 'order_change_decide',
			rest: 'POST /api/projects/{id}/order/changes/{changeId}/decide',
			role: 'Editor'
		},
		{
			tauri: 'revenue_plan_replace',
			rest: 'PUT /api/projects/{id}/order/revenue-plan',
			role: 'Editor'
		},
		{
			tauri: 'revenue_recognition_create',
			rest: 'POST /api/projects/{id}/order/recognitions',
			role: 'Editor'
		},
		{
			tauri: 'revenue_recognition_cancel',
			rest: 'POST /api/projects/{id}/order/recognitions/{recognitionId}/cancel',
			role: 'Editor'
		},
		{ tauri: 'outlook_snapshot_create', rest: 'POST /api/outlook/snapshots', role: 'Editor' },
		// banto-cost P4a: 計算基準の追加（会社基準・案件の上書き）も editor 床＋authorize_audited。
		{ tauri: 'calc_basis_add', rest: 'POST /api/calc-basis', role: 'Editor' },
		{
			tauri: 'project_calc_basis_add',
			rest: 'POST /api/projects/{id}/calc-basis',
			role: 'Editor'
		},
		// banto-cost P4b: 工程・共通活動マスタと工数。editor 床＋authorize_audited
		// （工数の本人確認はサービス、承認は APPROVAL_POLICY）。
		{ tauri: 'phases_create', rest: 'POST /api/phases', role: 'Editor' },
		{ tauri: 'phases_update', rest: 'PUT /api/phases/{id}', role: 'Editor' },
		{ tauri: 'common_activities_create', rest: 'POST /api/common-activities', role: 'Editor' },
		{ tauri: 'common_activities_update', rest: 'PUT /api/common-activities/{id}', role: 'Editor' },
		{ tauri: 'time_entries_create', rest: 'POST /api/time-entries', role: 'Editor' },
		{ tauri: 'time_entries_update', rest: 'PUT /api/time-entries/{id}', role: 'Editor' },
		{ tauri: 'time_entries_delete', rest: 'DELETE /api/time-entries/{id}', role: 'Editor' },
		{ tauri: 'time_entries_submit', rest: 'POST /api/time-entries/{id}/submit', role: 'Editor' },
		{ tauri: 'time_entries_decide', rest: 'POST /api/time-entries/{id}/decide', role: 'Editor' },
		// banto-cost P4c: 予算版。editor 床＋authorize_audited（承認は APPROVAL_POLICY）。
		{
			tauri: 'budget_draft_create',
			rest: 'POST /api/projects/{id}/budget/draft',
			role: 'Editor'
		},
		{ tauri: 'budget_draft_update', rest: 'PUT /api/budget-versions/{id}', role: 'Editor' },
		{ tauri: 'budget_draft_delete', rest: 'DELETE /api/budget-versions/{id}', role: 'Editor' },
		{
			tauri: 'budget_draft_approve',
			rest: 'POST /api/budget-versions/{id}/approve',
			role: 'Editor'
		},
		// banto-cost P4d: 取引先・直接費・発注。editor 床＋authorize_audited
		// （直接費の本人確認はサービス、承認は APPROVAL_POLICY）。
		{ tauri: 'vendors_create', rest: 'POST /api/vendors', role: 'Editor' },
		{ tauri: 'vendors_update', rest: 'PUT /api/vendors/{id}', role: 'Editor' },
		{ tauri: 'direct_costs_create', rest: 'POST /api/direct-costs', role: 'Editor' },
		{ tauri: 'direct_costs_update', rest: 'PUT /api/direct-costs/{id}', role: 'Editor' },
		{ tauri: 'direct_costs_delete', rest: 'DELETE /api/direct-costs/{id}', role: 'Editor' },
		{ tauri: 'direct_costs_submit', rest: 'POST /api/direct-costs/{id}/submit', role: 'Editor' },
		{ tauri: 'direct_costs_decide', rest: 'POST /api/direct-costs/{id}/decide', role: 'Editor' },
		{ tauri: 'purchase_orders_create', rest: 'POST /api/purchase-orders', role: 'Editor' },
		{ tauri: 'purchase_orders_update', rest: 'PUT /api/purchase-orders/{id}', role: 'Editor' },
		{
			tauri: 'purchase_orders_revise',
			rest: 'POST /api/purchase-orders/{id}/revise',
			role: 'Editor'
		},
		// banto-cost P5: 完了見込版。editor 床＋authorize_audited（採用は APPROVAL_POLICY）。
		{
			tauri: 'forecast_draft_create',
			rest: 'POST /api/projects/{id}/forecast/draft',
			role: 'Editor'
		},
		{ tauri: 'forecast_draft_update', rest: 'PUT /api/forecast-versions/{id}', role: 'Editor' },
		{ tauri: 'forecast_draft_delete', rest: 'DELETE /api/forecast-versions/{id}', role: 'Editor' },
		{
			tauri: 'forecast_draft_adopt',
			rest: 'POST /api/forecast-versions/{id}/adopt',
			role: 'Editor'
		},
		// banto-cost P6a: 精算完了。editor 床＋authorize_audited（SettleProject）。
		{
			tauri: 'project_closeout_settle',
			rest: 'POST /api/projects/{id}/closeout',
			role: 'Editor'
		}
	];

	// ロール床を照合したい読み取り系の対（CR-6）。読み取りは rule 8 の存在対称の
	// 対象外（TAURI_READ/REST_READ）だが、ロール床の非対称は起こりうる — 実際
	// `audit_config_get`（Tauri=Viewer / REST=Admin）が非対称だった。
	const ROLE_READ = [
		{ tauri: 'audit_config_get', rest: 'GET /api/audit-log/config', role: 'Admin' },
		{ tauri: 'audit_log_list', rest: 'POST /api/audit-log/list', role: 'Admin' },
		{ tauri: 'system_info', rest: 'GET /api/system/info', role: 'Admin' },
		// banto-cost P2（ADR-0028）。案件メンバーの閲覧はロール床が viewer で、
		// その先の能力×案件範囲は両経路とも AuthzService::authorize_audited が判定する。
		{ tauri: 'authz_me', rest: 'GET /api/authz/me', role: 'Viewer' },
		{ tauri: 'authz_capabilities_get', rest: 'GET /api/users/{id}/capabilities', role: 'Admin' },
		{ tauri: 'project_members_list', rest: 'GET /api/projects/{id}/members', role: 'Viewer' },
		// banto-cost P3a の読み取り（ロール床は viewer、判定は各ハンドラ）。
		{ tauri: 'customers_list', rest: 'POST /api/customers/list', role: 'Viewer' },
		{ tauri: 'customers_get', rest: 'GET /api/customers/{id}', role: 'Viewer' },
		{ tauri: 'projects_list', rest: 'POST /api/projects/list', role: 'Viewer' },
		{ tauri: 'projects_get', rest: 'GET /api/projects/{id}', role: 'Viewer' },
		{
			tauri: 'pipeline_versions_list',
			rest: 'GET /api/projects/{id}/pipeline-versions',
			role: 'Viewer'
		},
		{ tauri: 'pipeline_overview', rest: 'GET /api/pipeline/overview', role: 'Viewer' },
		// banto-cost P3b の読み取り。
		{ tauri: 'order_get', rest: 'GET /api/projects/{id}/order', role: 'Viewer' },
		{ tauri: 'outlook_get', rest: 'GET /api/outlook', role: 'Viewer' },
		{ tauri: 'outlook_snapshots_list', rest: 'GET /api/outlook/snapshots', role: 'Viewer' },
		{ tauri: 'outlook_snapshot_get', rest: 'GET /api/outlook/snapshots/{id}', role: 'Viewer' },
		// banto-cost P4a の読み取り（影響の事前確認は保存しないので読み取り側）。
		{ tauri: 'calc_basis_get', rest: 'GET /api/calc-basis', role: 'Viewer' },
		{ tauri: 'calc_basis_preview', rest: 'POST /api/calc-basis/preview', role: 'Viewer' },
		{
			tauri: 'project_calc_basis_get',
			rest: 'GET /api/projects/{id}/calc-basis',
			role: 'Viewer'
		},
		{
			tauri: 'project_calc_basis_preview',
			rest: 'POST /api/projects/{id}/calc-basis/preview',
			role: 'Viewer'
		},
		// banto-cost P4b の読み取り。
		{ tauri: 'phases_list', rest: 'GET /api/phases', role: 'Viewer' },
		{ tauri: 'common_activities_list', rest: 'GET /api/common-activities', role: 'Viewer' },
		{ tauri: 'time_entries_list', rest: 'GET /api/time-entries', role: 'Viewer' },
		{ tauri: 'time_entries_approvals', rest: 'GET /api/time-entries/approvals', role: 'Viewer' },
		{
			tauri: 'project_time_summary',
			rest: 'GET /api/projects/{id}/time-summary',
			role: 'Viewer'
		},
		// banto-cost P4c の読み取り。
		{ tauri: 'project_budget', rest: 'GET /api/projects/{id}/budget', role: 'Viewer' },
		// banto-cost P4d の読み取り。
		{ tauri: 'vendors_list', rest: 'GET /api/vendors', role: 'Viewer' },
		{ tauri: 'direct_costs_list', rest: 'GET /api/direct-costs', role: 'Viewer' },
		{ tauri: 'direct_costs_approvals', rest: 'GET /api/direct-costs/approvals', role: 'Viewer' },
		{ tauri: 'project_costs', rest: 'GET /api/projects/{id}/costs', role: 'Viewer' },
		// banto-cost P5 の読み取り。
		{ tauri: 'project_forecast', rest: 'GET /api/projects/{id}/forecast', role: 'Viewer' },
		{ tauri: 'portfolio_overview', rest: 'GET /api/portfolio', role: 'Viewer' },
		// banto-cost P6a の読み取り。
		{ tauri: 'project_closeout_get', rest: 'GET /api/projects/{id}/closeout', role: 'Viewer' }
	];

	// REST-only（Tauri 側に対を持たないのが正しい mutating ルート）。
	// `POST /api/auth/grant/{kind}` は、登録済みの種類（grant）の固定 identity の
	// セッションを、資格情報を持たないクライアントに発行する口（ADR-0017。
	// 閲覧公開はその 1 種類）。Tauri ウィンドウに「grant に入る」という操作は
	// 存在せず（M11 ログイン不要モードは `auth_config_apply` の設定で入る別機構）、
	// 同名の Tauri コマンドを足すのは誤りなので REST のみとする。
	// desktop-only の鏡像として、ここに分類することで rule 8 (c) を通す。
	// `POST /api/reach-check`（Issue #219 段階 1、lan-reach-check-design.md §5.2）は、
	// 管理者の画面が発行した使い捨てのトークンで「別の端末から届いた」ことを記録する
	// 口。Tauri のウィンドウに「別の端末として到達する」操作は存在せず、対の Tauri
	// コマンドを作るとこのPC自身からのアクセスを確認として扱う誤りになるので REST のみ。
	// セッションは発行しない（ロール床の照合の対象外）。
	const REST_ONLY = new Set(['POST /api/auth/grant/{kind}', 'POST /api/reach-check']);

	// desktop-only（OS/ローカル統合。REST を持たないのが正しい、§1 の対称対象外）。
	const DESKTOP_ONLY = new Set([
		'vibrancy_apply',
		'autologin_enable',
		'autologin_disable',
		'server_apply',
		// Issue #219 PR-C2: makes a one-time reach-check token (memory only, not
		// audited - lan-reach-check-design D8). Only this PC's administrator
		// issues; no REST twin by design (§5.1).
		'reach_check_issue',
		// Issue #219 stage 2 (ADR-0021 decision 12): adds/removes this PC's
		// firewall rule through the UAC-elevated helper (admin, audited as
		// `firewall_change`). The firewall is this PC's - no REST twin.
		'firewall_rule_change',
		'settings_set',
		'auth_config_apply',
		'panel_open',
		'backups_open_folder'
	]);

	// 読み取り系（list/get/status。§1 により両経路とも監査せず、対称強制の対象外）。
	const TAURI_READ = new Set([
		'audit_config_get',
		'audit_log_list',
		'auth_check',
		'authz_capabilities_get',
		'authz_me',
		'customers_get',
		'customers_list',
		'auth_config_get',
		'auth_identity',
		'auth_resolve',
		'auth_status',
		'backups_list',
		'backups_pending',
		// Issue #219 PR-B: reads this PC's Windows Firewall (admin, like
		// server_status). Desktop-only by nature - no REST twin.
		'firewall_rule_status',
		'ping',
		'calc_basis_get',
		'calc_basis_preview',
		'common_activities_list',
		'order_get',
		'outlook_get',
		'outlook_snapshot_get',
		'outlook_snapshots_list',
		'pipeline_overview',
		'phases_list',
		'pipeline_versions_list',
		'project_calc_basis_get',
		'project_calc_basis_preview',
		'project_members_list',
		'projects_get',
		'projects_list',
		'project_time_summary',
		'project_budget',
		'project_costs',
		'project_forecast',
		'portfolio_overview',
		'project_closeout_get',
		'vendors_list',
		'direct_costs_list',
		'direct_costs_approvals',
		'time_entries_approvals',
		'time_entries_list',
		// Issue #219 PR-C2: the reach check of the live listener (admin, like
		// server_status). Desktop-only by nature - no REST twin.
		'reach_check_status',
		'server_status',
		'system_info',
		'settings_get',
		'ui_settings_get',
		'users_list',
		'vibrancy_status'
	]);

	// 読み取り系 REST ルート（GET と、body を使うため POST の *_list）。
	const REST_READ = new Set([
		'GET /api/auth/status',
		'GET /api/auth/check',
		'GET /api/auth/identity',
		'GET /api/events',
		'GET /api/users',
		'GET /api/authz/me',
		'GET /api/users/{id}/capabilities',
		'GET /api/projects/{id}/members',
		'GET /api/customers/{id}',
		'GET /api/projects/{id}',
		'GET /api/projects/{id}/pipeline-versions',
		'GET /api/pipeline/overview',
		'GET /api/projects/{id}/order',
		'GET /api/outlook',
		'GET /api/outlook/snapshots',
		'GET /api/outlook/snapshots/{id}',
		'GET /api/calc-basis',
		'POST /api/calc-basis/preview',
		'GET /api/projects/{id}/calc-basis',
		'POST /api/projects/{id}/calc-basis/preview',
		'GET /api/phases',
		'GET /api/common-activities',
		'GET /api/time-entries',
		'GET /api/time-entries/approvals',
		'GET /api/projects/{id}/time-summary',
		'GET /api/projects/{id}/budget',
		'GET /api/projects/{id}/costs',
		'GET /api/projects/{id}/forecast',
		'GET /api/projects/{id}/closeout',
		'GET /api/portfolio',
		'GET /api/vendors',
		'GET /api/direct-costs',
		'GET /api/direct-costs/approvals',
		'POST /api/customers/list',
		'POST /api/projects/list',
		'GET /api/ui-settings/{key}',
		'GET /api/audit-log/config',
		'GET /api/system/info',
		'GET /api/backups',
		'GET /api/backups/{fileName}',
		'GET /api/backups/pending-restore',
		'POST /api/audit-log/list'
	]);

	// --- 一次情報のパース ---
	// Tauri: トップレベルのコマンド。tests は #[tauri::command] を付けないので混入しない。
	const tauriLib = 'apps/admin-template/src-tauri/src/lib.rs';
	const tauriCmds = new Set();
	if (fs.existsSync(path.join(repoRoot, tauriLib))) {
		const src = read(tauriLib);
		for (const m of src.matchAll(
			/#\[tauri::command\][^\n]*\n\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g
		))
			tauriCmds.add(m[1]);
	}

	// REST: rest/mod.rs の Route table（doc）。METHOD + path（クエリ除去）。
	const restRoutes = new Set();
	for (const line of read('apps/admin-template/core/src/rest/mod.rs').split('\n')) {
		const m = line.match(/^\/\/!\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/);
		if (m) restRoutes.add(`${m[1]} ${m[2].split('?')[0].trim()}`);
	}

	// 実ルート宣言（doc-sync 用）: app rest/ + banto-server の .route("path")。
	// 存在確認だけなので test 由来の重複は無害（1件あれば足りる）。
	// ドメイン非依存のルータは theme C PR-C4（docs/template-scope.md §7 移行順
	// ④）で `banto-server` に移設済み。実装がどちらのクレートにあっても
	// Route table（doc）との同期とロール床の対称は同じように検査する。
	const restRouterDirs = ['apps/admin-template/core/src/rest', 'crates/banto-server/src'];
	const declaredPaths = new Set();
	for (const dir of restRouterDirs) {
		for (const file of walk(dir, ['.rs'])) {
			for (const m of read(file).matchAll(/\.route\(\s*"([^"]+)"/g)) declaredPaths.add(m[1]);
		}
	}

	// --- チェック ---
	// (a) マニフェストの両端が実在すること。
	for (const { tauri, rest } of DUAL_PATH) {
		if (!tauriCmds.has(tauri))
			fail(rule, tauriLib, `dual-path 操作の Tauri コマンド \`${tauri}\` が見つからない`);
		if (!restRoutes.has(rest))
			fail(
				rule,
				'rest/mod.rs',
				`dual-path 操作の REST ルート \`${rest}\` が Route table に無い（片側だけ変更した可能性）`
			);
	}
	// (b) Tauri 完全性: 全コマンドが dual-path / desktop-only / read のいずれか。
	const dualTauri = new Set(DUAL_PATH.map((d) => d.tauri));
	for (const cmd of tauriCmds) {
		if (dualTauri.has(cmd) || DESKTOP_ONLY.has(cmd) || TAURI_READ.has(cmd)) continue;
		fail(
			rule,
			tauriLib,
			`未分類の Tauri コマンド \`${cmd}\` — REST とペアにして DUAL_PATH に足すか、desktop-only / read に分類（§1 両経路対称）`
		);
	}
	// (c) REST 完全性: 全ルートが dual-path / read / rest-only のいずれか。
	const dualRest = new Set(DUAL_PATH.map((d) => d.rest));
	for (const route of restRoutes) {
		if (dualRest.has(route) || REST_READ.has(route) || REST_ONLY.has(route)) continue;
		fail(
			rule,
			'rest/mod.rs',
			`未分類の REST ルート \`${route}\` — Tauri コマンドとペアにして DUAL_PATH に足すか REST_READ / REST_ONLY に分類（§1 両経路対称）`
		);
	}
	// (d) doc-sync: Route table の各 path が実際の .route() 宣言に存在すること。
	for (const route of restRoutes) {
		const p = route.split(' ')[1];
		if (!declaredPaths.has(p))
			fail(
				rule,
				'rest/mod.rs',
				`Route table の \`${p}\` に対応する .route() 宣言が見当たらない（doc と実装のドリフト）`
			);
	}

	// (e) ロール床の対称（CR-6, 2026-07-22 / maintainability-review CR-6）。
	// rule 8 の (a)〜(d) は「両経路に在るか」までで、**同じロール床か**は見ない
	// （＝ `audit_config_get` の Tauri=Viewer / REST=Admin 非対称を素通しした）。
	// ここは DUAL_PATH / ROLE_READ に宣言した期待ロールに対し、Tauri 実装
	// （`require_role(&state, Role::X, …)`。thin wrapper は `<cmd>_body` に委譲する
	// ため _body フォールバックを持つ）と REST 実装（その route を束ねる
	// `RoleGuard { min: Role::X }`。無ければ `require_auth` のみ = Viewer 床）の
	// 双方が宣言と一致するか照合する。`src-tauri` はコンパイルできないため静的解析。
	if (fs.existsSync(path.join(repoRoot, tauriLib))) {
		const libSrc = read(tauriLib);
		// Tauri: 全 async fn → その本体で最初に現れる require_role の Role。
		const tauriRoles = {};
		for (const seg of libSrc.split(/\basync fn /).slice(1)) {
			const nm = seg.match(/^(\w+)/);
			if (!nm) continue;
			const rm = seg.match(/require_role\(\s*&?\s*state\s*,\s*Role::(\w+)\s*,/);
			tauriRoles[nm[1]] = rm ? rm[1] : null;
		}
		const tauriRoleOf = (cmd) => tauriRoles[cmd] ?? tauriRoles[`${cmd}_body`] ?? null;

		// REST: "METHOD /path" → ロール床。各 `fn *_router` 本体（rustfmt 済みなので
		// 関数の閉じ括弧は行頭 `}`）から RoleGuard の min（無ければ require_auth=Auth）を取り、
		// その本体内の `.route("path", <verbs>(...))` の各メソッドに割り当てる。
		// 走査先は上の doc-sync (d) と同じ2ディレクトリ: ドメイン非依存のルータは
		// `banto-server`（theme C PR-C4, docs/template-scope.md §7 移行順 ④）、
		// アプリ固有のルータ（authz・projects 等）はアプリの `rest/` にある。ロール床は
		// どちらに実装があっても同一でなければならない。
		const restRouteRole = {};
		for (const file of restRouterDirs.flatMap((dir) => [...walk(dir, ['.rs'])])) {
			for (const fnM of read(file).matchAll(/\bfn \w+_router\b[\s\S]*?\n\}/g)) {
				const body = fnM[0];
				const minM = body.match(/min:\s*Role::(\w+)/);
				const role = minM ? minM[1] : /require_auth\b/.test(body) ? 'Auth' : 'Public';
				for (const chunk of body.split('.route(').slice(1)) {
					const pathM = chunk.match(/^\s*"([^"]+)"/);
					if (!pathM) continue;
					const p = pathM[1].split('?')[0].trim();
					const methodsSeg = chunk.split(/\.with_state|\.layer|\.route\(/)[0];
					for (const vm of methodsSeg.matchAll(/\b(get|post|put|delete)\s*\(/g))
						restRouteRole[`${vm[1].toUpperCase()} ${p}`] = role;
				}
			}
		}

		// `require_auth` のみ（RoleGuard 無し）は最下位ロール = Viewer 床と同値。
		const normRole = (r) => (r === 'Auth' ? 'Viewer' : r);
		const roleChecks = [...DUAL_PATH.filter((d) => d.role), ...ROLE_READ];
		for (const { tauri, rest, role } of roleChecks) {
			const want = normRole(role);
			const tr = tauriRoleOf(tauri);
			const rr = restRouteRole[rest] ?? null;
			if (normRole(tr) !== want || normRole(rr) !== want)
				fail(
					rule,
					tauriLib,
					`ロール床の非対称/不一致 \`${tauri}\` ⇔ \`${rest}\`: 期待=${role} / Tauri=${tr ?? '不明'} / REST=${rr ?? '不明'}（§1 両経路で同一の認可、CR-6）`
				);
		}
	}

	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(
			rule,
			`両経路対称: dual-path ${DUAL_PATH.length} 対（ロール床照合 ${DUAL_PATH.filter((d) => d.role).length} + read ${ROLE_READ.length}）+ Tauri ${tauriCmds.size} コマンド / REST ${restRoutes.size} ルート（うち rest-only ${REST_ONLY.size}）を分類済み`
		);
}

// --- 9. §6 セキュリティ不変条件（grep 可能なもの、CR-2） ------------------
//
// §6 の不変条件のうち、静的テキストで確実に・低誤検知で検査できるものだけを
// 機械化する（順序依存やセマンティックなもの＝body limit の順序・監査 detail に
// 秘密を入れない等はレビュー/テスト担保のまま）。
{
	const rule = 'security-invariants';

	// B) `settings_get` と `settings_set` は同一ロール（Admin）でゲートする。
	//    「同一ストアでも権限の非対称を作らない」（§6）。任意 key を読めるのは
	//    書けるのと同格の権限。ui_settings（viewer 可・自名前空間）は別コマンドで
	//    対象外。
	const libFile = 'apps/admin-template/src-tauri/src/lib.rs';
	const libSrc = read(libFile);
	const settingsRoleOf = (fnName) => {
		const m = libSrc.match(
			new RegExp(
				`async fn ${fnName}\\b[\\s\\S]{0,600}?require_role\\(\\s*&state\\s*,\\s*Role::(\\w+)\\s*,\\s*"settings"`
			)
		);
		return m ? m[1] : null;
	};
	const getRole = settingsRoleOf('settings_get');
	const setRole = settingsRoleOf('settings_set');
	if (getRole !== 'Admin' || setRole !== 'Admin' || getRole !== setRole)
		fail(
			rule,
			libFile,
			`settings_get(${getRole ?? '不明'}) と settings_set(${setRole ?? '不明'}) は同一 Admin ゲートであること（§6 権限の非対称を作らない）`
		);

	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, 'NewAttachment に mime 無し / settings_get·set は Admin 対称');
}

// --- 10. app 層コンポーネントの生日本語リテラル（conventions §13） ----------
//
// UI 文言はキー経由（Paraglide messages）で持ち、生の日本語を app 層の .svelte
// コンポーネントに直書きしない（§13、ADR-0005）。§9 の生色値
// 検査と同型: コメントを除去した本文に「語を構成する」日本語（ひらがな・
// カタカナ・CJK。区切り「・」等の句読点は翻訳対象の文言ではないので範囲外）が
// 無いことを grep で担保する。生成物（paraglide/）と辞書（messages/*.json＝
// .svelte ではない）は対象外。i18n は app 層のみ（§13）なので packages は見ない。
{
	const rule = 'raw-jp-in-app';
	const APP_PKG = 'apps/admin-template/package.json';
	const i18nMode = readI18nMode(path.join(repoRoot, APP_PKG));
	if (i18nMode === 'raw') {
		// D1-c (display-preset-plan.md, Issue #190 prep): app 層は preset
		// ごとに opt-out できる。`@banto/*` パッケージ側は messages 注入方式の
		// まま不変 — このスキップは apps/admin-template/src の検査だけに効く。
		skip(rule, `${APP_PKG} banto.i18n = "raw"`);
	} else {
		// 語を構成する日本語のみ（句読点・記号は除く）＝翻訳対象の「文言」を狙い撃つ。
		const JP = /[぀-ゟ゠-ヺー-ヿ一-鿿]/;
		// コメント除去（raw-colors と同じ割り切り）。行コメントの `//` は `http://`
		// を誤除去しないよう直前が `:` でない場合のみ落とす。
		const stripComments = (src) =>
			src
				.replace(/<!--[\s\S]*?-->/g, '')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/(^|[^:])\/\/.*$/gm, '$1');
		let checked = 0;
		for (const file of walk('apps/admin-template/src', ['.svelte'])) {
			if (file.includes('/paraglide/')) continue; // 生成物
			if (RAW_JP_ALLOWLIST.has(file)) continue;
			checked++;
			const lines = stripComments(read(file)).split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (JP.test(lines[i]))
					fail(
						rule,
						file,
						`生の日本語リテラル（${i + 1} 行目）— messages キーに置き Paraglide 経由 \`m['...']()\` で参照する（§13）`
					);
			}
		}
		if (!results.some((r) => r.includes(`[${rule}]`)))
			pass(rule, `app 層 ${checked} .svelte コンポーネントに生の日本語リテラルなし`);
	}
}

// --- 11. dev optimizer から .svelte.ts ソース配布パッケージを除外（issue #150 / ADR-0007）
//
// ソース配布された `.svelte.ts`（runes モジュール）は、派生アプリでは node_modules
// 実体になり Vite dev の依存オプティマイザが preprocess 無しで svelte.compileModule に
// 渡すため `import type` 等で 500 になる（ADR-0007）。対策として admin-template の
// vite.config.ts の optimizeDeps.exclude に列挙するが、新しい .svelte.ts 同梱パッケージを
// 足したときに列挙を忘れると静かに再発する。ここで「admin-template が依存し .svelte.ts を
// src/ に持つ @banto/*」= exclude リストの一致を機械検査する（scaffold の packages 同期
// トリップワイヤと同型）。
{
	const rule = 'optimizedeps-svelte-source';
	const APP_PKG = 'apps/admin-template/package.json';
	const VITE = 'apps/admin-template/vite.config.ts';
	// admin-template が依存する @banto/* のうち、src/ に .svelte.ts を持つもの。
	const deps = Object.keys(JSON.parse(read(APP_PKG)).dependencies ?? {}).filter((d) =>
		d.startsWith('@banto/')
	);
	const needsExclude = deps
		.filter((d) => {
			const pkgDir = `packages/${d.slice('@banto/'.length)}/src`;
			return [...walk(pkgDir, ['.svelte.ts'])].length > 0;
		})
		.sort();
	// vite.config.ts の optimizeDeps.exclude 配列に載っている @banto/* を抽出。
	const viteSrc = read(VITE);
	const excludeBlock = viteSrc.match(/exclude:\s*\[([^\]]*)\]/s)?.[1] ?? '';
	const excluded = [...excludeBlock.matchAll(/'(@banto\/[^']+)'/g)].map((m) => m[1]).sort();
	const missing = needsExclude.filter((d) => !excluded.includes(d));
	const extra = excluded.filter((d) => !needsExclude.includes(d));
	for (const d of missing)
		fail(
			rule,
			VITE,
			`${d} は .svelte.ts をソース配布するのに optimizeDeps.exclude 未登録（issue #150 の再発。派生アプリの dev が 500 になる）`
		);
	for (const d of extra)
		fail(
			rule,
			VITE,
			`${d} は .svelte.ts を持たないのに optimizeDeps.exclude に登録（不要。削除するかコメントで理由を明記）`
		);
	if (missing.length === 0 && extra.length === 0)
		pass(
			rule,
			`optimizeDeps.exclude が .svelte.ts ソース配布 ${needsExclude.length} パッケージと一致`
		);
}

// --- rule 11: マイグレーション方言のファイル名対称（conventions §11、ADR-0008） -
// SQLite と Postgres の2系統マイグレーションは歩調同期。中身は byte 別物でよい
// （db.rs の型分岐 = 意図的）が、ファイル名/連番は一致必須。片系統だけに足すと
// その backend のスキーマが静かに欠落する（各 sqlx::migrate! はディレクトリ独立、
// PG CI は smoke のみで捕捉しない = 「静かに壊れる」）。本検査はファイル名/連番の
// 対称のみ — 同名ペア内の型差は §11 の意図的分岐でレビュー担保。
{
	const rule = 'migration-dialect-parity';
	const base = 'apps/admin-template/core';
	const listSql = (d) => {
		const abs = path.join(repoRoot, base, d);
		if (!fs.existsSync(abs)) return null;
		return fs
			.readdirSync(abs)
			.filter((f) => f.endsWith('.sql'))
			.sort();
	};
	const sq = listSql('migrations-sqlite');
	const pg = listSql('migrations-postgres');
	if (!sq || !pg) {
		fail(
			rule,
			base,
			'migrations-sqlite/ か migrations-postgres/ が見つからない（検査の前提が変わった — 本検査を更新）'
		);
	} else {
		const onlySq = sq.filter((f) => !pg.includes(f));
		const onlyPg = pg.filter((f) => !sq.includes(f));
		for (const f of onlySq)
			fail(
				rule,
				`${base}/migrations-sqlite/${f}`,
				'postgres 側に対応ファイルが無い — 片系統だけにマイグレーションを足した（§11: 方言2系統は歩調同期。中身は byte 別物でよいがファイル名/連番は一致させる）'
			);
		for (const f of onlyPg)
			fail(rule, `${base}/migrations-postgres/${f}`, 'sqlite 側に対応ファイルが無い（同上、§11）');
		if (onlySq.length === 0 && onlyPg.length === 0)
			pass(
				rule,
				`方言2系統のマイグレーション ${sq.length} 本がファイル名一致（同名ペア内の型差は §11 の意図的分岐でレビュー担保。本検査はファイル名/連番の対称のみ）`
			);
	}
}

// --- rule 12: CSP 2定義のディレクティブ単位一致（conventions §6、ADR-0008） ------
// Content-Security-Policy は LAN サーバ（security_headers.rs の const）と Tauri
// webview（tauri.conf.json の app.security.csp）の2箇所に別形式で定義される。
// 唯一の意図的差分は connect-src（Tauri は IPC 用に ipc: http://ipc.localhost を
// 追加。banto-server の TAURI_IPC_CONNECT_SRC）。他は全ディレクティブ一致必須。
// src-tauri は非コンパイルなので、片方だけ緩める編集は静かに XSS/exfil 面を広げる
// （= 背骨 + 静かに壊れる + AI が踏みやすい）。文字列としての完全一致は
// apps/admin-template/core/tests/tauri_window_csp.rs（cargo test）が別に確かめる。
{
	const rule = 'csp-two-definitions';
	const SERVER = 'crates/banto-server/src/security_headers.rs';
	const TAURI = 'apps/admin-template/src-tauri/tauri.conf.json';
	// Tauri 側が connect-src に追加してよい source（§6 の唯一の意図的差分）。
	const CONNECT_SRC_TAURI_EXTRA = ['ipc:', 'http://ipc.localhost'];

	// "name 'a' b; …" → Map(name -> sorted sources[])。source 集合をソートして
	// 順不同で比較する。
	const parseDirectives = (csp) => {
		const map = new Map();
		for (const part of csp.split(';')) {
			const tokens = part.trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) continue;
			const [name, ...sources] = tokens;
			map.set(name, sources.sort());
		}
		return map;
	};

	const serverSrc = read(SERVER);
	// const 文字列を取り出し、Rust の行継続（`\` + 改行 + 先頭空白）を畳んで
	// 実行時文字列を復元する。
	const m = serverSrc.match(/CONTENT_SECURITY_POLICY: &str = "([\s\S]*?)";/);
	const tauriCsp = JSON.parse(read(TAURI))?.app?.security?.csp;

	if (!m || typeof tauriCsp !== 'string') {
		fail(
			rule,
			!m ? SERVER : TAURI,
			'CSP 定義が抽出できない（const 名か JSON パスが変わった — 本検査を更新）'
		);
	} else {
		const server = parseDirectives(m[1].replace(/\\\r?\n\s*/g, ''));
		const tauri = parseDirectives(tauriCsp);
		const names = new Set([...server.keys(), ...tauri.keys()]);
		let mismatches = 0;
		for (const name of names) {
			const s = server.get(name);
			const t = tauri.get(name);
			if (!s || !t) {
				mismatches++;
				fail(
					rule,
					!s ? SERVER : TAURI,
					`ディレクティブ ${name} が片方の CSP にしか無い（§6: connect-src 以外は両定義一致）`
				);
			} else if (name === 'connect-src') {
				// tauri 側 = server 側 ∪ {ipc:, http://ipc.localhost}。
				const expected = [...new Set([...s, ...CONNECT_SRC_TAURI_EXTRA])].sort();
				if (t.join(' ') !== expected.join(' ')) {
					mismatches++;
					fail(
						rule,
						TAURI,
						`connect-src が「server ∪ {ipc:, http://ipc.localhost}」と不一致（§6 の唯一の許容差分。server=[${s.join(' ')}] tauri=[${t.join(' ')}]）`
					);
				}
			} else if (s.join(' ') !== t.join(' ')) {
				mismatches++;
				fail(
					rule,
					TAURI,
					`ディレクティブ ${name} が2定義で不一致（§6: 片方だけ緩めると防御が崩れる。server=[${s.join(' ')}] tauri=[${t.join(' ')}]）`
				);
			}
		}
		if (mismatches === 0)
			pass(
				rule,
				`CSP 2定義（security_headers.rs / tauri.conf.json）が ${names.size} ディレクティブで一致（connect-src の IPC 差分のみ許容、§6）`
			);
	}
}

// --- rule 13: 外部利用 fixture の対象の漏れ（#271、docs/upgrading.md §8） ------
// .github/workflows/external-consumer.yml は fixtures/external-consumer/ を Git 依存で
// 導入して dev 起動・check・build・cargo check する。検証の対象（`.svelte.ts` を
// ソース配布するパッケージ・公開 crate）を手書きの一覧にすると、新しいパッケージ／
// crate を足したときに fixture が追随せず、#150 型の壊れを素通しする。ここで
// workspace から機械的に洗い出した集合と fixture を突き合わせる。公開 crate は
// `crates/*`（`apps/*` はアプリ固有で対象外。docs/publishing.md のタグ運用規約）。
{
	const rule = 'external-consumer-fixture';
	const FIX = 'fixtures/external-consumer';
	const FIX_PKG = `${FIX}/package.json`;
	const FIX_PAGE = `${FIX}/src/routes/+page.svelte`;
	const FIX_VITE = `${FIX}/vite.config.ts`;
	const FIX_CARGO = `${FIX}/rust/Cargo.toml`;
	const listDirs = (dir) =>
		fs
			.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	const missingFiles = [FIX_PKG, FIX_PAGE, FIX_VITE, FIX_CARGO].filter(
		(f) => !fs.existsSync(path.join(repoRoot, f))
	);
	if (!fs.existsSync(path.join(repoRoot, FIX))) {
		// scaffold した派生アプリでは fixture ごと除去される（banto 本体のリリース
		// 検証専用。scripts/scaffold.mjs の removeBantoReleaseOnly）。
		pass(rule, `対象外（${FIX} が無い — banto 本体専用の fixture。scaffold で除去済み）`);
	} else if (missingFiles.length > 0) {
		for (const f of missingFiles)
			fail(rule, f, 'fixture のファイルが無い（検査の前提が変わった — 本検査を更新）');
	} else {
		let problems = 0;
		const bad = (file, detail) => {
			problems++;
			fail(rule, file, detail);
		};

		// --- npm: packages/* のうち src/ に .svelte.ts を持つもの ---
		const svelteTs = listDirs('packages')
			.filter((d) => fs.existsSync(path.join(repoRoot, 'packages', d, 'package.json')))
			.filter((d) => [...walk(`packages/${d}/src`, ['.svelte.ts'])].length > 0)
			.map((d) => JSON.parse(read(`packages/${d}/package.json`)).name)
			.sort();
		const fixDeps = JSON.parse(read(FIX_PKG)).dependencies ?? {};
		const bantoDeps = Object.keys(fixDeps).filter((d) => d.startsWith('@banto/'));
		const imports = new Set(
			[...read(FIX_PAGE).matchAll(/from\s+'(@banto\/[^'/]+)'/g)].map((m) => m[1])
		);
		const excludeBlock = read(FIX_VITE).match(/exclude:\s*\[([^\]]*)\]/s)?.[1] ?? '';
		const excluded = [...excludeBlock.matchAll(/'(@banto\/[^']+)'/g)].map((m) => m[1]).sort();
		for (const name of svelteTs) {
			if (!bantoDeps.includes(name))
				bad(FIX_PKG, `${name} は .svelte.ts をソース配布するのに fixture の dependencies に無い`);
			if (!imports.has(name))
				bad(
					FIX_PAGE,
					`${name} は .svelte.ts をソース配布するのに +page.svelte が import していない（ブラウザがモジュールグラフを読まない）`
				);
			if (!excluded.includes(name))
				bad(FIX_VITE, `${name} が fixture の optimizeDeps.exclude に無い（#150 / ADR-0007）`);
		}
		for (const name of excluded.filter((d) => !svelteTs.includes(d)))
			bad(FIX_VITE, `${name} は .svelte.ts を持たないのに fixture の optimizeDeps.exclude にある`);

		// --- npm の ref: すべて github:tyaro/banto#<ref>&path:packages/<実在> ---
		const npmRefs = new Set();
		const pkgNames = new Map(
			listDirs('packages')
				.filter((d) => fs.existsSync(path.join(repoRoot, 'packages', d, 'package.json')))
				.map((d) => [JSON.parse(read(`packages/${d}/package.json`)).name, d])
		);
		for (const dep of bantoDeps) {
			const m = String(fixDeps[dep]).match(/^github:tyaro\/banto#([^&]+)&path:packages\/(.+)$/);
			if (!m) {
				bad(FIX_PKG, `${dep} が github:tyaro/banto#<ref>&path:packages/<x> の形でない`);
				continue;
			}
			npmRefs.add(m[1]);
			if (pkgNames.get(dep) !== m[2])
				bad(FIX_PKG, `${dep} の path:packages/${m[2]} が packages/ の実体と一致しない`);
		}

		// --- Rust: crates/* の全 crate = fixture の banto の Git 依存 ---
		const crates = listDirs('crates')
			.filter((d) => fs.existsSync(path.join(repoRoot, 'crates', d, 'Cargo.toml')))
			.map(
				(d) =>
					read(`crates/${d}/Cargo.toml`).match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms)?.[1]
			)
			.filter(Boolean)
			.sort();
		const cargoDeps = new Map(
			[
				...read(FIX_CARGO).matchAll(
					/^([\w-]+)\s*=\s*\{[^}\n]*git\s*=\s*"https:\/\/github\.com\/tyaro\/banto\.git"[^}\n]*\}/gm
				)
			].map((m) => [m[1], m[0].match(/\b(?:rev|tag)\s*=\s*"([^"]*)"/)?.[1]])
		);
		for (const c of crates.filter((c) => !cargoDeps.has(c)))
			bad(FIX_CARGO, `公開 crate ${c}（crates/）が fixture の Git 依存に無い`);
		for (const c of [...cargoDeps.keys()].filter((c) => !crates.includes(c)))
			bad(FIX_CARGO, `${c} は crates/ に無い（公開対象外か名前の誤り）`);
		const cargoRefs = new Set(cargoDeps.values());
		if (cargoRefs.has(undefined))
			bad(
				FIX_CARGO,
				'banto の Git 依存に rev / tag = "..." が無いものがある（set-ref が書き換えられない）'
			);

		// --- ref が npm・Cargo で 1 つに揃っている ---
		const refs = new Set([...npmRefs, ...cargoRefs].filter(Boolean));
		if (refs.size > 1)
			bad(
				FIX,
				`npm と Cargo の ref が揃っていない（${[...refs].join(', ')}）— node scripts/external-fixture-set-ref.mjs <ref> で揃える`
			);

		// --- Vite／Svelte 系の版が admin-template と揃っている ---
		// fixture は「admin-template と同じ組み合わせ」で外部利用を確かめるもの
		// （docs/upgrading.md §8.3 の表）。片方だけ上げると、検証した組み合わせと
		// 派生アプリの基準がずれる。範囲指定は**文字列のまま一致**を求める（`^` の
		// 有無・下限の違いも不一致）。`^8.3.0` と `8.3.0` は解決される版が違いうる
		// ので、正規化して同一視すると「同じ範囲」の保証が崩れる。
		const SYNCED_TOOLCHAIN = [
			'svelte',
			'@sveltejs/kit',
			'vite',
			'@sveltejs/vite-plugin-svelte',
			'@sveltejs/adapter-static',
			'svelte-check',
			'typescript'
		];
		const TEMPLATE_PKG = 'apps/admin-template/package.json';
		const rangesOf = (rel) => {
			const pkg = JSON.parse(read(rel));
			return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		};
		const appRanges = rangesOf(TEMPLATE_PKG);
		const fixRanges = rangesOf(FIX_PKG);
		for (const name of SYNCED_TOOLCHAIN) {
			const a = appRanges[name];
			const f = fixRanges[name];
			if (a === undefined && f === undefined) continue;
			if (a === undefined || f === undefined)
				bad(
					f === undefined ? FIX_PKG : TEMPLATE_PKG,
					`${name} が片方にしか無い（admin-template=${a ?? 'なし'}、fixture=${f ?? 'なし'}）`
				);
			else if (a !== f)
				bad(
					FIX_PKG,
					`${name} の範囲指定が admin-template と違う（admin-template=${a}、fixture=${f}）— 同じ文字列に揃える`
				);
		}

		if (problems === 0)
			pass(
				rule,
				`fixture が .svelte.ts ソース配布 ${svelteTs.length} パッケージ（import・exclude とも）と公開 crate ${crates.length} 個を網羅、Vite／Svelte 系 ${SYNCED_TOOLCHAIN.length} 件の範囲が admin-template と一致（ref ${[...refs].join(', ')}）`
			);
	}
}

// --- rule 14: scaffold が触るファイルと template-acceptance の paths の一致（ADR-0008）
// scripts/scaffold.mjs は字面（アンカー）でアプリ側のファイルを編集する。template-
// acceptance.yml はそのファイルを `paths` に手書きで列挙し、変わった PR でだけ受け入れ
// CI を走らせる。足し忘れると、アプリ側の変更でアンカーが壊れても受け入れ CI が走らず
// 静かに壊れる（#122 と 8730373 で再発。maintenance-review-2026-10 R-3 で
// vite.config.ts の抜けを実際に検出）。編集対象は手書きせず、全プリセットの
// `--dry-run --list-touched` から scaffold 自身に出させ、push / pull_request の両方の
// `paths` のどれかの glob に一致することを検査する。削除だけの対象（removeFile /
// removeDir）はアンカーが無いので対象外。この検査自体は frontend ジョブで毎回走る。
{
	const rule = 'scaffold-acceptance-paths';
	const WF = '.github/workflows/template-acceptance.yml';
	// banto 本体だけで走らせる。派生アプリにも scaffold.mjs と受け入れ WF は残るが、
	// 利用者が scaffold の編集対象（display の monitor 画面など）を書き換えると全プリセットの
	// dry-run が失敗し、paths と無関係な編集でこの検査が落ちる。本体の目印は2つ:
	// banto 本体専用の fixture（scaffold の共通 cleanup が消す。rule 13 と同じ目印）と、
	// ルート package.json の name が `banto` のまま（rename.mjs が書き換える）。
	const rootName = JSON.parse(read('package.json')).name;
	if (
		!fs.existsSync(path.join(repoRoot, 'scripts/scaffold.mjs')) ||
		!fs.existsSync(path.join(repoRoot, WF)) ||
		!fs.existsSync(path.join(repoRoot, 'fixtures/external-consumer')) ||
		rootName !== 'banto'
	) {
		pass(
			rule,
			`対象外（banto 本体専用 — scaffold 済み・rename 済みの派生アプリ、または scaffold.mjs / ${WF} が無い）`
		);
	} else {
		// `on:` 直下の `push:` / `pull_request:` の `paths:` 配下の `- '...'` 行だけを読む。
		const pathsOf = {};
		let trigger = null;
		let inPaths = false;
		for (const line of read(WF).split(/\r?\n/)) {
			if (/^\S/.test(line)) trigger = null; // `on:` 外のトップレベルキー
			const t = /^ {2}(\w+):\s*$/.exec(line);
			if (t) {
				trigger = t[1];
				inPaths = false;
				continue;
			}
			if (trigger && /^ {4}paths:\s*$/.test(line)) {
				inPaths = true;
				pathsOf[trigger] = [];
				continue;
			}
			if (inPaths) {
				const m = /^ {6}- '([^']+)'/.exec(line);
				if (m) pathsOf[trigger].push(m[1]);
				else if (/^ {0,4}\S/.test(line)) inPaths = false;
			}
		}
		// glob は `**`（`/` を越える）と `*`（越えない）だけ。
		const globToRe = (g) =>
			new RegExp(
				`^${g
					.split('**')
					.map((part) =>
						part
							.split('*')
							.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
							.join('[^/]*')
					)
					.join('.*')}$`
			);
		const { edited } = collectScaffoldTouchedFiles(repoRoot);
		let problems = 0;
		for (const kind of ['push', 'pull_request']) {
			const globs = pathsOf[kind];
			if (!globs || globs.length === 0) {
				problems++;
				fail(rule, WF, `${kind} の paths を読めない（検査の前提が変わった — 本検査を更新）`);
				continue;
			}
			const res = globs.map(globToRe);
			const missing = edited.filter((f) => !res.some((re) => re.test(f)));
			if (missing.length > 0) {
				problems++;
				fail(
					rule,
					WF,
					`${kind} の paths に、scaffold が編集するファイルが無い: ${missing.join(', ')}（受け入れ CI が走らず、アンカー切れが潜伏する）`
				);
			}
		}
		if (problems === 0)
			pass(
				rule,
				`scaffold が編集する ${edited.length} ファイル（全プリセット）が、${WF} の push / pull_request 両方の paths に含まれる`
			);
	}
}

// --- 結果 -------------------------------------------------------------------

console.log('verify:architecture — docs/conventions.md の機械検査\n');
for (const line of results) console.log(line);
if (failures > 0) {
	console.error(
		`\n${failures} 件の違反。意図的な例外なら、正当化コメントをコードに書いた上で本スクリプトの許可リストに理由付きで追加してください。`
	);
	process.exit(1);
}
console.log('\nすべて通過');
