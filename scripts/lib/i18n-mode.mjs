/**
 * i18n opt-out スイッチの読み取り（display-preset-plan.md D1-c / Issue #190）。
 *
 * `apps/admin-template/package.json` の `banto.i18n` フィールドを
 * `scripts/verify-architecture.mjs`（rule 10 `raw-jp-in-app`）と
 * `scripts/check-i18n-nonempty.mjs` が共有して読む、小さな純粋関数。
 *
 * - `"keys"`（既定・未設定時のフォールバック）… 今日の挙動。UI 文言はキー経由
 *   （Paraglide messages）で持つ（conventions §13）。
 * - `"raw"` … 単一言語アプリが UI 文言を直書きしてよい opt-out
 *   （display プリセット、Issue #190）。`@banto/*` パッケージ側の
 *   messages 注入方式には無関係（アプリ層のみのスイッチ）。
 *
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリのみ。
 */
import fs from 'node:fs';

/** 認識する値。未知の値は既定 `"keys"` にフォールバックする（fail-safe）。 */
const VALID_MODES = new Set(['keys', 'raw']);

/**
 * `pkgJsonPath`（`apps/admin-template/package.json` への絶対/相対パス）から
 * `banto.i18n` を読む。フィールド欠如・パース不能・未知の値はすべて
 * 既定 `"keys"`（＝今日の挙動）にフォールバックする。
 *
 * @param {string} pkgJsonPath
 * @returns {'keys' | 'raw'}
 */
export function readI18nMode(pkgJsonPath) {
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
	} catch {
		return 'keys';
	}
	const mode = pkg?.banto?.i18n;
	return VALID_MODES.has(mode) ? mode : 'keys';
}
