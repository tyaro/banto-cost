#!/usr/bin/env node
/**
 * ファイアウォールの許可を昇格して行う補助プログラム（helper）をビルドし、Tauri の
 * `externalBin` が読む場所へ置く（Issue #219 段階 2 の E4、ADR-0021 決定 2・3・7・8）。
 *
 * 呼ばれ方: `apps/admin-template/src-tauri/tauri.fw-elev.conf.json` の
 * `build.beforeBuildCommand`（`pnpm --filter admin-template tauri:build:windows` が
 * `tauri build --features embed-ui --config` でこの設定を重ねる）。Tauri が渡す `TAURI_ENV_TARGET_TRIPLE`・
 * `TAURI_ENV_DEBUG` に合わせて helper をビルドし、
 * `src-tauri/binaries/<bin>-<target triple>.exe` に複写する。Tauri はこれを
 * インストール先の本体 exe の**隣**に `<bin>.exe`（triple を外した固定名）で置く
 * — 本体（E2）と helper（E1）が互いを探す唯一の場所。
 *
 * 単独でも動く: `node scripts/build-fw-elev.mjs`（環境変数が無ければ host の triple・
 * release）。Windows の target 以外では helper に意味が無いので失敗する。
 *
 * 依存を足さない（Node 標準のみ、conventions §3）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(repoRoot, 'apps/admin-template/src-tauri');
const FW_ELEV_CONF = path.join(tauriDir, 'tauri.fw-elev.conf.json');

/**
 * `tauri.fw-elev.conf.json` の `bundle.externalBin` から helper の置き場所
 * （src-tauri からの相対パス、拡張子と triple なし）を読む。名前の一次情報は
 * この設定ファイルで、helper の crate のテストが `[[bin]]` 名との一致を確かめる。
 */
export function readSidecarBase(confText) {
	const bins = JSON.parse(confText)?.bundle?.externalBin;
	if (!Array.isArray(bins) || bins.length !== 1 || typeof bins[0] !== 'string') {
		throw new Error('tauri.fw-elev.conf.json の bundle.externalBin は helper の 1 件だけにする');
	}
	return bins[0];
}

/** Tauri の externalBin の命名（`<base>-<triple>.exe`）。 */
export function sidecarFileName(base, triple) {
	return `${path.posix.basename(base)}-${triple}.exe`;
}

/** `cargo build --message-format=json` の出力から、指定した bin の実行ファイルを探す。 */
export function findExecutable(jsonLines, binName) {
	let found = null;
	for (const line of jsonLines.split(/\r?\n/)) {
		if (!line.startsWith('{')) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			msg.reason === 'compiler-artifact' &&
			msg.target?.name === binName &&
			msg.target?.kind?.includes('bin') &&
			typeof msg.executable === 'string'
		) {
			found = msg.executable;
		}
	}
	return found;
}

function fail(message) {
	console.error(`build-fw-elev: ${message}`);
	process.exit(1);
}

function hostTriple() {
	const res = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
	const host = res.status === 0 ? /^host: (\S+)$/m.exec(res.stdout)?.[1] : undefined;
	if (!host) fail('rustc -vV から host の target triple を読めません');
	return host;
}

function main() {
	const base = readSidecarBase(fs.readFileSync(FW_ELEV_CONF, 'utf8'));
	const binName = path.posix.basename(base);
	const host = hostTriple();
	const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
	if (!triple.includes('windows')) {
		fail(
			`helper は Windows 専用です（target: ${triple}）。Windows のインストーラのビルドでだけ使います`
		);
	}
	const release = process.env.TAURI_ENV_DEBUG !== 'true';

	const args = ['build', '--bin', binName, '--message-format=json-render-diagnostics'];
	if (release) args.push('--release');
	// host と同じなら --target を付けない（tauri build の既定と同じ target/<profile> を使い、
	// 二重にビルドしない）。
	if (triple !== host) args.push('--target', triple);

	console.log(`build-fw-elev: cargo ${args.join(' ')}`);
	const res = spawnSync('cargo', args, {
		cwd: repoRoot,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'inherit']
	});
	if (res.status !== 0) fail(`cargo build が失敗しました（終了コード ${res.status}）`);
	const exe = findExecutable(res.stdout, binName);
	if (!exe) fail(`cargo の出力に ${binName} の実行ファイルがありません`);

	const dest = path.join(tauriDir, path.dirname(base), sidecarFileName(base, triple));
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(exe, dest);
	console.log(`build-fw-elev: ${path.relative(repoRoot, exe)} → ${path.relative(repoRoot, dest)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
