#!/usr/bin/env node
/**
 * バージョン整合検査（CR-7。maintainability-review-2026-07.md §7 追補）。
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリのみ。
 *
 * 背景: `v0.1.1` タグが存在する一方でマニフェストは `0.1.0` のまま、というドリフトが
 * 観測された（ChatGPT 計画レビュー #5）。これを機械で防ぐ。
 *
 * 2モード（オーナー指定で「通常CI」と「タグCI」を分離）:
 *   - 既定（通常CI）: 全マニフェストの version が相互に一致すること。
 *   - `--tag <name>`（タグCI・リリースワークフロー）: 上記に加え、タグ名 `vX.Y.Z` が
 *     マニフェスト version と一致すること。
 *
 * 例外: ルート `package.json` は private・非配布（`"version": "0.0.0"`）のため
 * 対象から除外する（オーナー指定）。crate の `version.workspace = true` は
 * workspace 値を継承するので個別確認は不要（workspace `Cargo.toml` のみ見る）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

// ルート package.json は private・非配布のため除外（0.0.0 のまま）。
const sources = [];
const jsonManifests = [
	'apps/admin-template/package.json',
	'apps/admin-template/src-tauri/tauri.conf.json',
	...fs
		.readdirSync(path.join(repoRoot, 'packages'))
		.map((d) => `packages/${d}/package.json`)
		.filter(exists)
];
for (const rel of jsonManifests) {
	const v = JSON.parse(read(rel)).version;
	if (v) sources.push({ rel, version: v });
}
// workspace Cargo.toml の [workspace.package] version。
const cargoM = read('Cargo.toml').match(/\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
if (cargoM) sources.push({ rel: 'Cargo.toml', version: cargoM[1] });

let failures = 0;
const fail = (msg) => {
	console.error(`  ✗ ${msg}`);
	failures++;
};

const versions = [...new Set(sources.map((s) => s.version))];
if (versions.length > 1) {
	fail('マニフェスト間で version が不一致:');
	for (const s of sources) console.error(`      ${s.rel}: ${s.version}`);
}
const version = sources[0]?.version;

const tagIdx = process.argv.indexOf('--tag');
if (tagIdx !== -1) {
	const tag = process.argv[tagIdx + 1] ?? '';
	const expected = `v${version}`;
	if (tag !== expected)
		fail(`タグ名 "${tag}" がマニフェスト version と不一致（期待 "${expected}"）`);
}

if (failures > 0) {
	console.error(`\n${failures} 件の不一致。マニフェストとタグ運用を整合させてください（CR-7）。`);
	process.exit(1);
}
console.log(
	`✔ バージョン整合: ${sources.length} マニフェストが ${version} で一致` +
		` (ルート package.json は private=0.0.0 で例外)` +
		(tagIdx !== -1 ? ` / タグ ${process.argv[tagIdx + 1]} 一致` : '')
);
