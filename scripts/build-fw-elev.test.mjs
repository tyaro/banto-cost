/**
 * `scripts/build-fw-elev.mjs` の純関数のテスト（Issue #219 段階 2 の E4）。
 * 実行: `node --test scripts/build-fw-elev.test.mjs`（cargo は呼ばない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable, readSidecarBase, sidecarFileName } from './build-fw-elev.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('tauri.fw-elev.conf.json の externalBin は helper 1 件で、本体の隣の固定名になる', () => {
	const conf = fs.readFileSync(
		path.join(repoRoot, 'apps/admin-template/src-tauri/tauri.fw-elev.conf.json'),
		'utf8'
	);
	const base = readSidecarBase(conf);
	assert.equal(base, 'binaries/admin-template-fw-elev');
	assert.equal(
		sidecarFileName(base, 'x86_64-pc-windows-msvc'),
		'admin-template-fw-elev-x86_64-pc-windows-msvc.exe'
	);
	// アンインストールのフックがあるのは NSIS だけなので、MSI は作らない。
	assert.deepEqual(JSON.parse(conf).bundle.targets, ['nsis']);
	// beforeBuildCommand は通常のフロントのビルドに helper のビルドを足したもの。
	assert.match(
		JSON.parse(conf).build.beforeBuildCommand,
		/^pnpm build && node \.\.\/\.\.\/scripts\/build-fw-elev\.mjs$/
	);
});

test('readSidecarBase は helper 以外が混ざった・空の externalBin を拒む', () => {
	assert.throws(() => readSidecarBase('{"bundle":{}}'));
	assert.throws(() => readSidecarBase('{"bundle":{"externalBin":["a","b"]}}'));
	assert.throws(() => readSidecarBase('{"bundle":{"externalBin":[1]}}'));
});

test('findExecutable は指定した bin の compiler-artifact の実行ファイルだけを拾う', () => {
	const lines = [
		'Compiling ...',
		JSON.stringify({
			reason: 'compiler-artifact',
			target: { name: 'admin_template_fw_elev', kind: ['lib'] },
			executable: null
		}),
		JSON.stringify({
			reason: 'compiler-artifact',
			target: { name: 'admin-template-fw-elev', kind: ['bin'] },
			executable: 'C:\\t\\release\\admin-template-fw-elev.exe'
		}),
		JSON.stringify({ reason: 'build-finished', success: true }),
		'{not json'
	].join('\n');
	assert.equal(
		findExecutable(lines, 'admin-template-fw-elev'),
		'C:\\t\\release\\admin-template-fw-elev.exe'
	);
	assert.equal(findExecutable(lines, 'other'), null);
});
