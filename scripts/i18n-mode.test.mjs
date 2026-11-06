/**
 * i18n opt-out スイッチ（display-preset-plan.md D1-c / Issue #190 準備）のテスト。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 1) `scripts/lib/i18n-mode.mjs` の `readI18nMode` 単体テスト（一時 JSON ファイル、
 *    軽量）。
 * 2) `scripts/verify-architecture.mjs`（rule `raw-jp-in-app`）と
 *    `scripts/check-i18n-nonempty.mjs` が `banto.i18n = "raw"` のとき実際に
 *    スキップして exit 0 になることを、一時コピー上で確認する統合テスト
 *    （方式は `scripts/rename.test.mjs` の copyRepo と同じ）。
 *
 * 実行: `node --test scripts/i18n-mode.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readI18nMode } from './lib/i18n-mode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 1. readI18nMode 単体テスト ----------------------------------------------

function writeTmpPkgJson(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-i18n-mode-'));
	const file = path.join(dir, 'package.json');
	fs.writeFileSync(file, content);
	return file;
}

test('readI18nMode: banto.i18n = "raw" を読む', () => {
	const file = writeTmpPkgJson(JSON.stringify({ banto: { i18n: 'raw' } }));
	assert.equal(readI18nMode(file), 'raw');
});

test('readI18nMode: banto.i18n = "keys" を読む', () => {
	const file = writeTmpPkgJson(JSON.stringify({ banto: { i18n: 'keys' } }));
	assert.equal(readI18nMode(file), 'keys');
});

test('readI18nMode: フィールド欠如は既定 "keys"', () => {
	const file = writeTmpPkgJson(JSON.stringify({ name: 'admin-template' }));
	assert.equal(readI18nMode(file), 'keys');
});

test('readI18nMode: 未知の値は既定 "keys" にフォールバック', () => {
	const file = writeTmpPkgJson(JSON.stringify({ banto: { i18n: 'nonsense' } }));
	assert.equal(readI18nMode(file), 'keys');
});

test('readI18nMode: ファイルが読めない/JSON が壊れていても既定 "keys"', () => {
	const file = writeTmpPkgJson('{ not valid json');
	assert.equal(readI18nMode(file), 'keys');
	assert.equal(readI18nMode(path.join(os.tmpdir(), 'does-not-exist-9999.json')), 'keys');
});

// --- 2. verify-architecture.mjs / check-i18n-nonempty.mjs の skip 統合テスト --

// コピーから除外する重い/不要なディレクトリ（rename.test.mjs と同じ方針）。
const SKIP = ['node_modules', '.git', 'target', '.svelte-kit', 'build', 'dist'];
const shouldSkip = (src) =>
	SKIP.some((s) => src === path.join(repoRoot, s) || src.includes(`${path.sep}${s}${path.sep}`)) ||
	src.includes('-snapshots');

function copyRepo() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-i18n-skip-'));
	fs.cpSync(repoRoot, tmp, { recursive: true, filter: (src) => !shouldSkip(src) });
	return tmp;
}

function setI18nMode(tmp, mode) {
	const pkgPath = path.join(tmp, 'apps/admin-template/package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.banto = { ...pkg.banto, i18n: mode };
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

test('verify-architecture: banto.i18n = "raw" だと raw-jp-in-app をスキップして exit 0', () => {
	const tmp = copyRepo();
	setI18nMode(tmp, 'raw');
	const res = spawnSync(process.execPath, ['scripts/verify-architecture.mjs'], {
		cwd: tmp,
		encoding: 'utf8'
	});
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(
		res.stdout,
		/− \[raw-jp-in-app\] スキップ（apps\/admin-template\/package\.json banto\.i18n = "raw"）/
	);
});

test('verify-architecture: banto.i18n 未設定（既定 "keys"）は従来どおり raw-jp-in-app を実行する', () => {
	const tmp = copyRepo();
	const res = spawnSync(process.execPath, ['scripts/verify-architecture.mjs'], {
		cwd: tmp,
		encoding: 'utf8'
	});
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /✔ \[raw-jp-in-app\]/);
});

test('check-i18n-nonempty: banto.i18n = "raw" だとスキップして exit 0（生成物が無くても）', () => {
	const tmp = copyRepo();
	setI18nMode(tmp, 'raw');
	// 生成物ディレクトリが存在しない状態でもスキップが先に効くことを確認する。
	const messagesDir = path.join(tmp, 'apps/admin-template/src/lib/paraglide/messages');
	fs.rmSync(messagesDir, { recursive: true, force: true });
	const res = spawnSync(process.execPath, ['scripts/check-i18n-nonempty.mjs'], {
		cwd: tmp,
		encoding: 'utf8'
	});
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /− \[check-i18n-nonempty\] スキップ/);
});
