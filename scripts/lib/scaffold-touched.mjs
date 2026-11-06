/**
 * scaffold が編集・削除の対象にするファイルの一覧を、scaffold 自身から得る。
 * 手書きの一覧は足し忘れる（template-acceptance.yml の `paths` が実例）ので、
 * 全プリセットを `--dry-run --list-touched` で回し、和集合を返す。
 * 依存を足さない（conventions §3）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * scripts/scaffold.mjs の PRESETS のキー（`--list-presets`）。手書きで複製すると、
 * プリセットを足したときにその編集対象が検査から漏れる。
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listScaffoldPresets(repoRoot) {
	const res = spawnSync(
		process.execPath,
		[path.join(repoRoot, 'scripts/scaffold.mjs'), '--list-presets'],
		{ cwd: repoRoot, encoding: 'utf8' }
	);
	if (res.status !== 0) throw new Error(`scaffold --list-presets が失敗しました:\n${res.stderr}`);
	const presets = res.stdout.split(/\r?\n/).filter(Boolean);
	if (presets.length === 0)
		throw new Error('scaffold --list-presets がプリセットを返しませんでした');
	return presets;
}

/**
 * @param {string} repoRoot
 * @returns {{ edited: string[], removed: string[] }}
 *   edited = アンカーで編集するファイル、removed = 丸ごと消すファイル/ディレクトリ。
 *   リポジトリ相対パス（`/` 区切り、ソート済み、重複なし）。
 */
export function collectScaffoldTouchedFiles(repoRoot) {
	const edited = new Set();
	const removed = new Set();
	for (const preset of listScaffoldPresets(repoRoot)) {
		const res = spawnSync(
			process.execPath,
			[
				path.join(repoRoot, 'scripts/scaffold.mjs'),
				'--preset',
				preset,
				'--dry-run',
				'--list-touched'
			],
			{ cwd: repoRoot, encoding: 'utf8' }
		);
		if (res.status !== 0)
			throw new Error(`scaffold --preset ${preset} --dry-run が失敗しました:\n${res.stderr}`);
		for (const line of res.stdout.split(/\r?\n/)) {
			const m = /^(TOUCHED|REMOVED) (.+)$/.exec(line);
			if (m) (m[1] === 'TOUCHED' ? edited : removed).add(m[2].replaceAll('\\', '/'));
		}
	}
	return { edited: [...edited].sort(), removed: [...removed].sort() };
}
