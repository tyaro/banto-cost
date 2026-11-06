#!/usr/bin/env node
/**
 * リリース済み migration の凍結検査（#312 の P1 の再発防止）。
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリと git のみ。
 *
 * なぜ: SQLx は適用した migration の本文（コメントを含む全文）の checksum を
 * `_sqlx_migrations` に記録し、起動時に埋め込み版（`sqlx::migrate!` はコンパイル
 * 時に SQL を取り込む）と照合する。リリース済みの migration をコメント 1 行でも
 * 書き換えると、その版以前に作った DB は `VersionMismatch(<version>)` で起動
 * しなくなる（#312 の design/ 移動でコメント内のパスを書き換えて実際に起きかけた）。
 * よって migration は追記のみ（append-only）: 新しい連番のファイルを足すのは
 * よいが、リリース済みのファイルの変更・削除・改名は許さない。
 *
 * 検査:
 *   1. HEAD から辿れる最新の `v*` タグを `git describe --tags --abbrev=0 --match 'v*'`
 *      で求める
 *   2. そのタグのツリーで `migrations*` という名前のディレクトリ配下にある
 *      ファイルをすべて列挙する（apps/・crates/・packages/ を問わない）
 *   3. それらをタグと作業ツリーで `git diff --no-renames --name-status` で比べる。
 *      git が保存するときの形（.gitattributes の eol 正規化後）で比較するので、
 *      チェックアウト時の改行変換だけでは違反にならない
 *   変更（M/T）・削除（D）が 1 件でもあれば exit 1。タグ以降に足したファイルは対象外。
 *
 * `v*` タグが 1 つもない（浅い clone でもない）リポジトリでは検査対象がないので
 * 成功扱いで終える。浅い clone（CI の actions/checkout の既定）ではタグが見えず
 * 黙って素通りしうるので失敗にする — CI では `fetch-depth: 0` で checkout する。
 *
 * 実行: `pnpm verify:migrations`（CI の frontend ジョブ）。
 * テスト: `node --test scripts/verify-migrations-frozen.test.mjs`
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** migration とみなすディレクトリ（パスのどこかに `migrations*` という名前の階層を含む）。 */
export const MIGRATION_PATH = /(^|\/)migrations[^/]*\//;

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024
	});
}

/**
 * リリース済み migration の変更・削除を集める。
 * @param {{ cwd?: string }} [opts]
 * @returns {{ tag: string | null, checked: number, violations: { status: string, path: string }[] }}
 */
export function findFrozenMigrationViolations({ cwd = repoRoot } = {}) {
	if (git(['tag', '--list', 'v*'], cwd).trim() === '') {
		if (git(['rev-parse', '--is-shallow-repository'], cwd).trim() === 'true') {
			throw new Error(
				'浅い clone で v* タグが見えない。リリース済み migration を比べられないので失敗にする' +
					'（CI では actions/checkout に fetch-depth: 0 を付ける）'
			);
		}
		return { tag: null, checked: 0, violations: [] };
	}
	let tag;
	try {
		tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], cwd).trim();
	} catch {
		throw new Error(
			'HEAD から辿れる v* タグが無い（浅い clone なら fetch-depth: 0 で取り直す）。' +
				'リリース済み migration を比べられないので失敗にする'
		);
	}
	const files = git(['ls-tree', '-r', '--name-only', '-z', tag], cwd)
		.split('\0')
		.filter((p) => p !== '' && MIGRATION_PATH.test(p));
	if (files.length === 0) return { tag, checked: 0, violations: [] };

	const out = git(
		[
			'diff',
			'--no-renames',
			'--no-ext-diff',
			'--no-textconv',
			'--name-status',
			'-z',
			tag,
			'--',
			...files.map((f) => `:(literal)${f}`)
		],
		cwd
	);
	const fields = out.split('\0').filter((s) => s !== '');
	const violations = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		violations.push({ status: fields[i], path: fields[i + 1] });
	}
	return { tag, checked: files.length, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { tag, checked, violations } = findFrozenMigrationViolations();
		if (tag === null) {
			console.log('verify-migrations-frozen: v* タグが無いので検査対象なし（成功扱い）');
			process.exit(0);
		}
		if (violations.length > 0) {
			const label = (s) => (s === 'D' ? '削除' : '変更');
			console.error(
				`verify-migrations-frozen: リリース済み（${tag}）の migration が書き換えられている:`
			);
			for (const v of violations) console.error(`  [${label(v.status)}] ${v.path}`);
			console.error(
				[
					'',
					'SQLx は適用済み migration の本文（コメントを含む全文）の checksum を DB に記録して',
					`起動時に照合する。${tag} 以前に作った DB は VersionMismatch で起動しなくなる。`,
					'リリース済みの migration は追記のみ: 元のバイト列に戻し',
					`（git checkout ${tag} -- <file>）、変更は新しい連番の migration で行うこと。`
				].join('\n')
			);
			process.exit(1);
		}
		console.log(
			`verify-migrations-frozen: ${tag} のリリース済み migration ${checked} 件はすべて不変`
		);
	} catch (err) {
		console.error(`verify-migrations-frozen: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
