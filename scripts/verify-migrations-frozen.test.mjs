/**
 * `scripts/verify-migrations-frozen.mjs` のテスト（#312 の P1 の再発防止）。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 方式: 一時ディレクトリに git リポジトリを作り、migration を commit して `v*` タグを
 * 打ってから作業ツリーを変え、変更・削除・改名を違反として拾うこと、新しい連番の
 * 追加・改行コードだけの違い・タグ以降の変更（新しいタグを打った後）は通すことを
 * 確かめる。実リポジトリは触らない。
 *
 * 実行: `node --test scripts/verify-migrations-frozen.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFrozenMigrationViolations, MIGRATION_PATH } from './verify-migrations-frozen.mjs';

const SCRIPT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'verify-migrations-frozen.mjs'
);

const GIT_ID = [
	'-c',
	'user.name=test',
	'-c',
	'user.email=test@example.invalid',
	'-c',
	'commit.gpgsign=false',
	'-c',
	'tag.gpgsign=false',
	'-c',
	'core.autocrlf=false'
];

function git(cwd, ...args) {
	return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function write(root, rel, content) {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

const SQLITE = 'app/core/migrations-sqlite';
const PG = 'app/core/migrations-postgres';

/** migration 2 系統 + 無関係なファイルを commit し、v1.0.0 を打ったリポジトリ。 */
function releasedRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-mig-frozen-'));
	git(root, 'init', '-q', '-b', 'main');
	write(root, '.gitattributes', '* text=auto eol=lf\n');
	write(
		root,
		`${SQLITE}/0001_items.sql`,
		'-- spec docs/plan.md\nCREATE TABLE items (id INTEGER);\n'
	);
	write(root, `${PG}/0001_items.sql`, '-- spec docs/plan.md\nCREATE TABLE items (id BIGINT);\n');
	write(root, 'docs/plan.md', '# plan\n');
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'init');
	git(root, 'tag', 'v1.0.0');
	return root;
}

function cleanup(root) {
	fs.rmSync(root, { recursive: true, force: true });
}

test('MIGRATION_PATH は migrations* という名前の階層だけを拾う', () => {
	assert.ok(MIGRATION_PATH.test('apps/x/core/migrations-sqlite/0001.sql'));
	assert.ok(MIGRATION_PATH.test('migrations/0001.sql'));
	assert.ok(MIGRATION_PATH.test('crates/y/migrations/sub/0001.sql'));
	assert.ok(!MIGRATION_PATH.test('docs/migrations.md'));
	assert.ok(!MIGRATION_PATH.test('docs/old-migrations/0001.sql'));
});

test('タグと同じなら違反なし', () => {
	const root = releasedRepo();
	try {
		const r = findFrozenMigrationViolations({ cwd: root });
		assert.equal(r.tag, 'v1.0.0');
		assert.equal(r.checked, 2);
		assert.deepEqual(r.violations, []);
	} finally {
		cleanup(root);
	}
});

test('コメントだけの書き換えも違反（SQLx の checksum はコメントを含む）', () => {
	const root = releasedRepo();
	try {
		write(
			root,
			`${SQLITE}/0001_items.sql`,
			'-- spec docs/design/plan.md\nCREATE TABLE items (id INTEGER);\n'
		);
		const r = findFrozenMigrationViolations({ cwd: root });
		assert.deepEqual(r.violations, [{ status: 'M', path: `${SQLITE}/0001_items.sql` }]);
	} finally {
		cleanup(root);
	}
});

test('commit 済みの書き換えも違反（作業ツリーが基準）', () => {
	const root = releasedRepo();
	try {
		write(root, `${PG}/0001_items.sql`, '-- edited\nCREATE TABLE items (id BIGINT);\n');
		git(root, 'commit', '-q', '-am', 'edit');
		const r = findFrozenMigrationViolations({ cwd: root });
		assert.deepEqual(r.violations, [{ status: 'M', path: `${PG}/0001_items.sql` }]);
	} finally {
		cleanup(root);
	}
});

test('削除・改名は違反、新しい連番の追加と migration 外の変更は通す', () => {
	const root = releasedRepo();
	try {
		fs.rmSync(path.join(root, `${PG}/0001_items.sql`));
		fs.renameSync(
			path.join(root, `${SQLITE}/0001_items.sql`),
			path.join(root, `${SQLITE}/0001_renamed.sql`)
		);
		write(root, `${SQLITE}/0002_more.sql`, 'CREATE TABLE more (id INTEGER);\n');
		write(root, 'docs/plan.md', '# plan (moved)\n');
		git(root, 'add', '-A');
		const r = findFrozenMigrationViolations({ cwd: root });
		assert.deepEqual(
			r.violations.sort((a, b) => a.path.localeCompare(b.path)),
			[
				{ status: 'D', path: `${PG}/0001_items.sql` },
				{ status: 'D', path: `${SQLITE}/0001_items.sql` }
			]
		);
	} finally {
		cleanup(root);
	}
});

test('改行コードだけの違いは git が保存する形で比べるので通す（eol=lf の正規化）', () => {
	const root = releasedRepo();
	try {
		write(
			root,
			`${SQLITE}/0001_items.sql`,
			'-- spec docs/plan.md\r\nCREATE TABLE items (id INTEGER);\r\n'
		);
		const r = findFrozenMigrationViolations({ cwd: root });
		assert.deepEqual(r.violations, []);
	} finally {
		cleanup(root);
	}
});

test('最新の到達可能な v* タグが基準（新しいリリース後の版は v1 との差を問わない）', () => {
	const root = releasedRepo();
	try {
		write(
			root,
			`${SQLITE}/0001_items.sql`,
			'-- edited before v2\nCREATE TABLE items (id INTEGER);\n'
		);
		git(root, 'commit', '-q', '-am', 'edit');
		git(root, 'tag', 'v2.0.0');
		const r = findFrozenMigrationViolations({ cwd: root });
		assert.equal(r.tag, 'v2.0.0');
		assert.deepEqual(r.violations, []);
		// v* 以外のタグは基準にしない
		write(
			root,
			`${SQLITE}/0001_items.sql`,
			'-- edited after v2\nCREATE TABLE items (id INTEGER);\n'
		);
		git(root, 'commit', '-q', '-am', 'edit2');
		git(root, 'tag', 'not-a-release');
		assert.equal(findFrozenMigrationViolations({ cwd: root }).violations.length, 1);
	} finally {
		cleanup(root);
	}
});

test('v* タグが無いリポジトリは検査対象なしで成功扱い', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-mig-frozen-'));
	try {
		git(root, 'init', '-q', '-b', 'main');
		write(root, `${SQLITE}/0001_items.sql`, 'CREATE TABLE items (id INTEGER);\n');
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'init');
		assert.deepEqual(findFrozenMigrationViolations({ cwd: root }), {
			tag: null,
			checked: 0,
			violations: []
		});
	} finally {
		cleanup(root);
	}
});

test('浅い clone でタグが見えないときは素通りさせず失敗にする', () => {
	const root = releasedRepo();
	const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-mig-frozen-shallow-'));
	try {
		const url = `file://${root.replace(/\\/g, '/')}`;
		git(shallow, 'clone', '-q', '--depth', '1', '--no-tags', url, 'c');
		assert.throws(
			() => findFrozenMigrationViolations({ cwd: path.join(shallow, 'c') }),
			/fetch-depth: 0/
		);
	} finally {
		cleanup(shallow);
		cleanup(root);
	}
});

test('CLI: 違反があれば exit 1 でファイル名と VersionMismatch の説明を出す', () => {
	const root = releasedRepo();
	try {
		// CLI はスクリプトの置き場所（リポジトリ根）を基準にするので、一時リポジトリへ複写する
		const script = path.join(root, 'scripts/verify-migrations-frozen.mjs');
		write(root, 'scripts/verify-migrations-frozen.mjs', fs.readFileSync(SCRIPT, 'utf8'));
		const ok = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
		assert.match(ok, /v1\.0\.0 のリリース済み migration 2 件はすべて不変/);

		write(root, `${PG}/0001_items.sql`, '-- edited\n');
		let failed = false;
		try {
			execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
		} catch (err) {
			failed = true;
			assert.equal(err.status, 1);
			assert.match(err.stderr, /\[変更\] app\/core\/migrations-postgres\/0001_items\.sql/);
			assert.match(err.stderr, /VersionMismatch/);
		}
		assert.ok(failed, '違反があるのに exit 0 だった');
	} finally {
		cleanup(root);
	}
});
