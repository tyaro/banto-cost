#!/usr/bin/env node
/**
 * テンプレート初期化スクリプト（improvement-plan-2026-07.md P2-1）。
 * Banto をコピーして自分のアプリを作るときの名称・識別子の一括書き換えを
 * 自動化する。依存を足さない文化（conventions §3）に従い Node 標準
 * ライブラリのみで動く。
 *
 * 使い方:
 *   node scripts/rename.mjs \
 *     --name my-app \
 *     --title "My App" \
 *     --identifier com.example.myapp \
 *     [--repo https://github.com/me/my-app] \
 *     [--description "説明文"] \
 *     [--dry-run]
 *
 * 書き換える箇所（docs/recipes/rename.md「スクリプトが書き換える箇所」の手動手順に対応）:
 *   - ルート package.json          … name（--name）/ description
 *   - apps/admin-template/package.json … name（"<name>-app"。ルートと同名に
 *     すると pnpm workspace 内で重複するため）
 *   - ルート package.json / e2e/playwright.config.ts の
 *     `--filter <旧アプリ名>` 参照 … 新アプリ名へ追随
 *   - src-tauri/tauri.conf.json    … productName（--title）/ identifier
 *     （--identifier）/ app.windows[0].title（--title）
 *   - apps/admin-template/elev/src/lib.rs の IDENTIFIER（ファイアウォールの helper の
 *     ビルド時の定数、ADR-0021 決定 5）… --identifier
 *   - src/app.html <title> + PWA の apple-mobile-web-app-title /
 *     Sidebar・ログイン画面のブランド表示 /
 *     panel ページの <title> 接尾辞 … --title
 *   - static/manifest.webmanifest name / short_name（PWA インストール名）… --title
 *   - e2e のログイン見出しアサーション（smoke / visual / a11y）… --title
 *   - Cargo.toml workspace.package.repository /
 *     packages/星/package.json repository.url … --repo（指定時のみ）
 *
 * 各置換は「ファイル内の現在値」を読み取ってから書き換えるため、2回目の
 * 実行や部分的にリネーム済みのツリーでも安全（見つからない置換は明示的に
 * 報告して失敗する。--dry-run で書き換え内容を事前確認できる）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createEditor, replaceAll } from './lib/template-edit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 引数 -------------------------------------------------------------------

function parseArgs(argv) {
	const args = { dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) fail(`${arg} に値がありません`);
			return value;
		};
		if (arg === '--name') args.name = next();
		else if (arg === '--title') args.title = next();
		else if (arg === '--identifier') args.identifier = next();
		else if (arg === '--repo') args.repo = next();
		else if (arg === '--description') args.description = next();
		else if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--help' || arg === '-h') usage(0);
		else fail(`不明な引数: ${arg}`);
	}
	return args;
}

function usage(code) {
	console.log(
		'使い方: node scripts/rename.mjs --name <kebab-name> --title <表示名> --identifier <逆順ドメイン> [--repo <URL>] [--description <説明>] [--dry-run]'
	);
	process.exit(code);
}

function fail(message) {
	console.error(`エラー: ${message}`);
	process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || !args.title || !args.identifier) usage(1);

if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name))
	fail(`--name は kebab-case（英小文字・数字・ハイフン）で指定してください: ${args.name}`);
// Tauri (と各OSのバンドル識別子) の要件: 英数字・ハイフンのセグメントを
// ドットで2つ以上つなぐ。先頭は英字。
if (!/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(args.identifier))
	fail(`--identifier は com.example.myapp 形式で指定してください: ${args.identifier}`);
if (args.repo && !/^https?:\/\/\S+$/.test(args.repo))
	fail(`--repo は URL で指定してください: ${args.repo}`);

// アプリパッケージは「<name>-app」（--name が既に -app で終わるならそのまま）。
// ルートと同名にすると pnpm workspace 内で名前が重複するため、その場合は
// ルート側を「<name>-workspace」に逃がす。
const appName = args.name.endsWith('-app') ? args.name : `${args.name}-app`;
const rootName = appName === args.name ? `${args.name}-workspace` : args.name;
const description = args.description ?? args.title;

// --- 置換エンジン -----------------------------------------------------------
// エンジン本体（editFile / jsonField / replaceAll / 変更ログ / 失敗報告）は
// scaffold.mjs と共有する scripts/lib/template-edit.mjs に集約している。

const editor = createEditor({ repoRoot, dryRun: args.dryRun });
const { editFile, jsonField } = editor;

// --- 1. パッケージ名と --filter 参照 ---------------------------------------

const oldAppName = JSON.parse(
	fs.readFileSync(path.join(repoRoot, 'apps/admin-template/package.json'), 'utf8')
).name;

jsonField('package.json', 'name', rootName);
jsonField('package.json', 'description', description);
jsonField('apps/admin-template/package.json', 'name', appName);

for (const rel of ['package.json', 'e2e/playwright.config.ts']) {
	editFile(rel, `--filter ${oldAppName} → --filter ${appName}`, (s) =>
		replaceAll(s, `--filter ${oldAppName}`, `--filter ${appName}`)
	);
}

// --- 2. Tauri 設定 ----------------------------------------------------------

const tauriConf = 'apps/admin-template/src-tauri/tauri.conf.json';
jsonField(tauriConf, 'productName', args.title);
jsonField(tauriConf, 'identifier', args.identifier);
editFile(tauriConf, `app.windows[0].title → "${args.title}"`, (s) => {
	const current = JSON.parse(s).app?.windows?.[0]?.title;
	if (typeof current !== 'string') return undefined;
	if (current === args.title) return null;
	return replaceAll(s, JSON.stringify(current), JSON.stringify(args.title));
});

// OS keyring service 名を新アプリの identifier へ追随させる（issue #147）。
// テンプレート出荷時は `dev.banto.admin-template` 固定だが、そのままだと同一 OS
// ユーザー上の複数派生アプリが同じ `(service, account)` を共有し、自動ログイン
// 資格情報が衝突・上書きされる。identifier は逆順ドメインで一意なので、初回
// リネームで keyring namespace をアプリ単位に分離する。以後のクレート改名で
// 資格情報を孤立させない配慮（keyring_store.rs のコメント）は、この初回1回の
// 名前空間分離とは別物。
editFile(
	'apps/admin-template/src-tauri/src/keyring_store.rs',
	`keyring SERVICE_NAME → "${args.identifier}"`,
	(s) => replaceAll(s, '"dev.banto.admin-template"', `"${args.identifier}"`)
);

// ファイアウォールの helper（Issue #219 段階 2、ADR-0021 決定 5）は identifier を
// ビルド時の定数で持つ（引数では受けない）。tauri.conf.json と食い違うと、本体は
// helper を起動せず（`firewall_rule_change` の照合）、helper の crate のテスト
// `identifier_matches_tauri_conf` も落ちる。ファイル内の現在値を読んで置き換える
// ので、部分的にリネーム済みのツリーでも追随する。NSIS のフック
// （`src-tauri/windows/fw-elev-hooks.nsh`）は Tauri の定義（BUNDLEID・
// MAINBINARYNAME）から名前を作るので、書き換え不要。
editFile(
	'apps/admin-template/elev/src/lib.rs',
	`fw-elev helper IDENTIFIER → "${args.identifier}"`,
	(s) => {
		const m = /pub const IDENTIFIER: &str = "([^"]*)";/.exec(s);
		if (!m) return undefined;
		return replaceAll(s, m[0], `pub const IDENTIFIER: &str = "${args.identifier}";`);
	}
);

// --- 3. 表示ブランド（現在の Sidebar 表記を正として全 UI を追随） -----------

const sidebarSrc = fs.readFileSync(
	path.join(repoRoot, 'apps/admin-template/src/lib/components/Sidebar.svelte'),
	'utf8'
);
const brandMatch = sidebarSrc.match(/class="brand-name">([^<]+)</);
if (!brandMatch) fail('Sidebar.svelte から現在のブランド名を検出できません');
const oldBrand = brandMatch[1];

editFile('apps/admin-template/src/app.html', `<title> → ${args.title}`, (s) =>
	replaceAll(s, `<title>${oldBrand}</title>`, `<title>${args.title}</title>`)
);
// PWA (M-review 2026-08 §2.8): the install/home-screen name comes from the
// manifest's name/short_name and the apple-mobile-web-app-title meta, so those
// must follow --title too or a renamed app still installs as "Banto".
editFile('apps/admin-template/src/app.html', `apple-mobile-web-app-title → ${args.title}`, (s) =>
	replaceAll(
		s,
		`name="apple-mobile-web-app-title" content="${oldBrand}"`,
		`name="apple-mobile-web-app-title" content="${args.title}"`
	)
);
editFile(
	'apps/admin-template/static/manifest.webmanifest',
	`PWA name/short_name → ${args.title}`,
	(s) => {
		const step1 = replaceAll(s, `"name": "${oldBrand}"`, `"name": "${args.title}"`);
		if (step1 === undefined || step1 === null) return step1;
		return (
			replaceAll(step1, `"short_name": "${oldBrand}"`, `"short_name": "${args.title}"`) ?? step1
		);
	}
);
editFile('apps/admin-template/src/lib/components/Sidebar.svelte', 'ブランド表示', (s) =>
	replaceAll(s, `class="brand-name">${oldBrand}<`, `class="brand-name">${args.title}<`)
);
editFile('apps/admin-template/src/routes/login/+page.svelte', 'ブランド表示 + 見出し', (s) => {
	const step1 = replaceAll(
		s,
		`class="brand-name">${oldBrand}<`,
		`class="brand-name">${args.title}<`
	);
	if (step1 === undefined || step1 === null) return step1;
	return replaceAll(step1, `<h1>${oldBrand}</h1>`, `<h1>${args.title}</h1>`) ?? step1;
});
editFile('apps/admin-template/src/routes/panel/[id]/+page.svelte', '<title> 接尾辞', (s) =>
	replaceAll(s, ` - ${oldBrand}</title>`, ` - ${args.title}</title>`)
);

// --- 4. e2e のログイン見出しアサーション ------------------------------------

for (const rel of [
	'e2e/tests/smoke.spec.ts',
	'e2e/visual/visual.spec.ts',
	'e2e/visual/a11y.spec.ts'
]) {
	editFile(rel, `ログイン見出し '${oldBrand}' → '${args.title}'`, (s) => {
		const step = replaceAll(s, `name: '${oldBrand}'`, `name: '${args.title}'`);
		if (step !== undefined) return step;
		return replaceAll(s, `heading: '${oldBrand}'`, `heading: '${args.title}'`);
	});
}

// --- 5. リポジトリ URL（--repo 指定時のみ） ---------------------------------

if (args.repo) {
	editFile('Cargo.toml', `repository → ${args.repo}`, (s) => {
		const match = s.match(/^repository = "([^"]+)"/m);
		if (!match) return undefined;
		if (match[1] === args.repo) return null;
		return replaceAll(s, `repository = "${match[1]}"`, `repository = "${args.repo}"`);
	});
	const gitUrl = args.repo.endsWith('.git') ? args.repo : `${args.repo}.git`;
	for (const dir of fs.readdirSync(path.join(repoRoot, 'packages'))) {
		const rel = `packages/${dir}/package.json`;
		if (!fs.existsSync(path.join(repoRoot, rel))) continue;
		editFile(rel, `repository.url → ${gitUrl}`, (s) => {
			const current = JSON.parse(s).repository?.url;
			if (typeof current !== 'string') return undefined;
			if (current === gitUrl) return null;
			return replaceAll(s, JSON.stringify(current), JSON.stringify(gitUrl));
		});
	}
}

// --- 結果 -------------------------------------------------------------------

if (editor.report(args.dryRun ? '--dry-run: 以下を書き換えます\n' : '書き換えました\n')) {
	process.exit(1);
}

console.log(`
残りの手動ステップ:
  1. pnpm install を再実行（ワークスペース名変更の反映）
  2. アイコン差し替え: pnpm --filter ${appName} tauri icon <画像>
  3. LICENSE の著作権者名・README/docs の文言は必要に応じて手動更新
     （docs/ 内のコマンド例は旧アプリ名のまま — ハードフォークなら docs/ は
     削除してよい。README「ドキュメントの2トラック」参照）
  4. visual regression のスナップショットは旧ブランドの見た目で撮られている
     ため再生成する: pnpm e2e:visual --update-snapshots （Linux 環境で）
  5. identifier 変更により、旧 identifier のアプリデータ
     （例: %APPDATA%/dev.banto.admin/）は引き継がれない（新規作成される）
  6. 検証: pnpm check / pnpm e2e / cargo test`);
