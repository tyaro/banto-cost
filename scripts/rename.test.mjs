/**
 * `scripts/rename.mjs` の統合テスト（AD-5 / maintainability-review-2026-07.md §7 追補）。
 * 第三者オンボーディングの第一歩＝「コピー → リネーム」が壊れていないことを
 * 機械で保証する。依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 方式: リポジトリを一時ディレクトリへコピー（重いディレクトリは除外）し、
 * コピー先の `rename.mjs` を実サンプル引数で実行して、ドキュメント（README §1）が
 * 約束する書き換えが実際に起きること・JSON が壊れないこと・旧識別子が残らないことを
 * 検証する。実リポジトリは一切書き換えない。
 *
 * 実行: `node --test scripts/rename.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// コピーから除外する重い/不要なディレクトリ（ビルド生成物・VCS・スナップショット）。
const SKIP = ['node_modules', '.git', 'target', '.svelte-kit', 'build', 'dist'];
const skip = (src) =>
	SKIP.some((s) => src === path.join(repoRoot, s) || src.includes(`${path.sep}${s}${path.sep}`)) ||
	src.includes('-snapshots');

function copyRepo() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-rename-'));
	fs.cpSync(repoRoot, tmp, { recursive: true, filter: (src) => !skip(src) });
	return tmp;
}

const SAMPLE = {
	name: 'widget-admin',
	title: 'Widget Admin',
	identifier: 'com.example.widget'
};

test('rename.mjs はサンプル引数で成功し、約束どおりの書き換えを行う', () => {
	const dir = copyRepo();
	try {
		const res = spawnSync(
			process.execPath,
			[
				path.join(dir, 'scripts/rename.mjs'),
				'--name',
				SAMPLE.name,
				'--title',
				SAMPLE.title,
				'--identifier',
				SAMPLE.identifier
			],
			{ cwd: dir, encoding: 'utf8' }
		);
		assert.equal(res.status, 0, `rename.mjs が非0終了:\n${res.stdout}\n${res.stderr}`);

		const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

		// ルート package.json の name（--name が -app で終わらないので workspace 名は素の name）。
		assert.equal(readJson('package.json').name, SAMPLE.name);

		// アプリ package.json の name は `<name>-app`。
		assert.equal(
			readJson('apps/admin-template/package.json').name,
			`${SAMPLE.name}-app`,
			'アプリ package.json の name が <name>-app になっていない'
		);

		// tauri.conf.json の identifier / productName。
		const tauri = readJson('apps/admin-template/src-tauri/tauri.conf.json');
		assert.equal(tauri.identifier, SAMPLE.identifier);
		assert.equal(tauri.productName, SAMPLE.title);
		assert.notEqual(tauri.identifier, 'dev.banto.admin', '旧 identifier が残っている');

		// keyring SERVICE_NAME が identifier に追随（issue #147: 派生アプリ間の
		// 資格情報 namespace 分離）。旧テンプレート既定が残っていないこと。
		const keyring = fs.readFileSync(
			path.join(dir, 'apps/admin-template/src-tauri/src/keyring_store.rs'),
			'utf8'
		);
		assert.match(keyring, new RegExp(`const SERVICE_NAME: &str = "${SAMPLE.identifier}";`));
		assert.doesNotMatch(
			keyring,
			/const SERVICE_NAME: &str = "dev\.banto\.admin-template";/,
			'keyring SERVICE_NAME にテンプレート既定が残っている'
		);

		// ファイアウォールの helper の identifier（ビルド時の定数、ADR-0021 決定 5）が
		// tauri.conf.json の identifier に追随（食い違うと helper が起動されない）。
		const fwElev = fs.readFileSync(path.join(dir, 'apps/admin-template/elev/src/lib.rs'), 'utf8');
		assert.match(fwElev, new RegExp(`pub const IDENTIFIER: &str = "${SAMPLE.identifier}";`));
		assert.doesNotMatch(fwElev, /"dev\.banto\.admin"/, 'helper に旧 identifier が残っている');

		// app.html の <title> が新タイトルに。
		const appHtml = fs.readFileSync(path.join(dir, 'apps/admin-template/src/app.html'), 'utf8');
		assert.match(appHtml, new RegExp(`<title>${SAMPLE.title}</title>`));

		// PWA のインストール名（manifest name/short_name + apple-title）も追随。
		const manifest = JSON.parse(
			fs.readFileSync(path.join(dir, 'apps/admin-template/static/manifest.webmanifest'), 'utf8')
		);
		assert.equal(manifest.name, SAMPLE.title);
		assert.equal(manifest.short_name, SAMPLE.title);
		assert.match(appHtml, new RegExp(`apple-mobile-web-app-title" content="${SAMPLE.title}"`));

		// 旧ブランド識別子が主要マニフェストに残っていないこと（回帰の早期検出）。
		assert.doesNotMatch(
			JSON.stringify(tauri),
			/dev\.banto\.admin|"Banto"/,
			'tauri.conf.json に旧ブランドが残っている'
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('rename.mjs --repo は Cargo.toml と全パッケージの repository を書き換える', () => {
	const dir = copyRepo();
	try {
		const repo = 'https://github.com/example/widget-admin';
		const res = spawnSync(
			process.execPath,
			[
				path.join(dir, 'scripts/rename.mjs'),
				'--name',
				SAMPLE.name,
				'--title',
				SAMPLE.title,
				'--identifier',
				SAMPLE.identifier,
				'--repo',
				repo
			],
			{ cwd: dir, encoding: 'utf8' }
		);
		assert.equal(res.status, 0, `--repo が非0終了:\n${res.stdout}\n${res.stderr}`);

		assert.match(
			fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'),
			/example\/widget-admin/,
			'Cargo.toml の repository が書き換わっていない'
		);
		const pkgDir = path.join(dir, 'packages');
		const pkgs = fs
			.readdirSync(pkgDir)
			.filter((d) => fs.existsSync(path.join(pkgDir, d, 'package.json')));
		for (const d of pkgs) {
			const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, d, 'package.json'), 'utf8'));
			assert.match(
				JSON.stringify(pkg.repository ?? ''),
				/example\/widget-admin/,
				`packages/${d} の repository.url が書き換わっていない`
			);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('rename.mjs --dry-run は何も書き換えない', () => {
	const dir = copyRepo();
	try {
		const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
		const res = spawnSync(
			process.execPath,
			[
				path.join(dir, 'scripts/rename.mjs'),
				'--name',
				SAMPLE.name,
				'--title',
				SAMPLE.title,
				'--identifier',
				SAMPLE.identifier,
				'--dry-run'
			],
			{ cwd: dir, encoding: 'utf8' }
		);
		assert.equal(res.status, 0, `--dry-run が非0終了:\n${res.stderr}`);
		const after = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
		assert.equal(after, before, '--dry-run がファイルを書き換えてしまった');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
