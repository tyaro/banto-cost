#!/usr/bin/env node
/**
 * i18n fail-closed ガード（出荷ブロッカー対応 / テンプレート実用性レビュー §2）。
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリのみ。
 *
 * 背景: `paraglide-js compile` は inlang プラグインの取得や設定解決に失敗しても
 * WARN を出したうえで exit 0 のまま「空のメッセージカタログ」を出力する（fail-open）。
 * その空カタログを参照する `src/lib/navigation.ts` 等の動的キー `m[key]()` は
 * 実行時に `undefined()` となり、README のターゲット（LAN/閉域網の業務端末）で
 * 画面が落ちる。CI はネットワークがあるため常に緑になり被害を検知できない。
 *
 * このガードは compile の後段で生成物のメッセージ件数を数え、
 *   - 0 件（＝空カタログ・fail-open）
 *   - ソース辞書 messages/en.json のキー数を下回る（＝部分失敗）
 * のいずれかで非0終了し、ビルドを fail-closed にする。
 *
 * 数え方:
 *   - 生成件数 = `src/lib/paraglide/messages/` 直下の `*.js`（`_index.js` を除く）。
 *     paraglide は 1 メッセージ = 1 モジュールを出力するため、これが生成件数。
 *   - しきい値 = ソース辞書 `messages/en.json` の非メタキー数（`$` 始まりを除く）。
 *     生成件数がこれ未満なら失敗（0 件は当然失敗）。
 *
 * D1-c (display-preset-plan.md, Issue #190 prep): `apps/admin-template/package.json`
 * の `banto.i18n = "raw"` は「単一言語アプリが UI 文言を直書きする」opt-out
 * （display プリセット）。paraglide の辞書自体は空のまま残る想定なので、この
 * ガードは意味を持たない（catalog が空でも fail-open ではなく「そもそも辞書を
 * 使わない」）— skip して理由を出力する。既定は今日どおり `"keys"`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readI18nMode } from './lib/i18n-mode.mjs';

const appRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'apps',
	'admin-template'
);
const messagesDir = path.join(appRoot, 'src', 'lib', 'paraglide', 'messages');
const sourceCatalog = path.join(appRoot, 'messages', 'en.json');
const appPkgJson = path.join(appRoot, 'package.json');

const i18nMode = readI18nMode(appPkgJson);
if (i18nMode === 'raw') {
	console.log(
		`− [check-i18n-nonempty] スキップ（apps/admin-template/package.json banto.i18n = "raw"）`
	);
	process.exit(0);
}

function fail(msg) {
	console.error(`\n[check-i18n-nonempty] FAIL: ${msg}`);
	console.error('  → paraglide-js compile が空/不完全なカタログを出力した可能性があります。');
	console.error(
		'    project.inlang/settings.json の modules 参照とプラグイン依存の解決を確認してください。'
	);
	process.exit(1);
}

// しきい値: ソース辞書のキー数。読めない場合は「0 でないこと」を最低ラインとする。
let threshold = 1;
try {
	const dict = JSON.parse(fs.readFileSync(sourceCatalog, 'utf8'));
	const keys = Object.keys(dict).filter((k) => !k.startsWith('$'));
	if (keys.length > 0) threshold = keys.length;
} catch (e) {
	console.error(
		`[check-i18n-nonempty] WARN: ソース辞書を読めませんでした (${sourceCatalog}): ${e.message}`
	);
	console.error('  → しきい値を「1 件以上」にフォールバックします。');
}

if (!fs.existsSync(messagesDir)) {
	fail(`生成ディレクトリが存在しません: ${messagesDir}`);
}

const generated = fs
	.readdirSync(messagesDir)
	.filter((name) => name.endsWith('.js') && name !== '_index.js');

if (generated.length === 0) {
	fail(`生成メッセージ件数が 0 件です（空カタログ = fail-open を捕捉）。`);
}

if (generated.length < threshold) {
	fail(
		`生成メッセージ件数 ${generated.length} 件がしきい値 ${threshold} 件（ソース辞書キー数）を下回ります。`
	);
}

console.log(
	`[check-i18n-nonempty] OK: 生成メッセージ ${generated.length} 件（しきい値 ${threshold} 件以上）。`
);
