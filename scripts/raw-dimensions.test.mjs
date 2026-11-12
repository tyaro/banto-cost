/**
 * 文字サイズと枠線幅の生値の検出（scripts/lib/raw-dimensions.mjs、
 * verify-architecture の rule `raw-dimensions`、theme-dimension-tokens.md D8）のテスト。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 実行: `node --test scripts/raw-dimensions.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRawDimensions } from './lib/raw-dimensions.mjs';

const raws = (css) => findRawDimensions(css).map((h) => `${h.prop} ${h.raw}`);

test('違反: font-size の生の絶対値と絶対キーワード', () => {
	assert.deepEqual(raws('.a { font-size: 1rem; }'), ['font-size 1rem']);
	assert.deepEqual(raws('.a { font-size: 12px }'), ['font-size 12px']);
	assert.deepEqual(raws('.a { font-size: 11pt; }'), ['font-size 11pt']);
	assert.deepEqual(raws('.a { font-size: small; }'), ['font-size small']);
	assert.deepEqual(raws('.a { FONT-SIZE: 0.8REM; }'), ['font-size 0.8REM']);
	assert.deepEqual(raws('.a { font-size: .9rem; }'), ['font-size .9rem']);
});

test('違反: font ショートハンドの文字サイズ（行送りは見ない）', () => {
	assert.deepEqual(raws('.a { font: 600 0.8rem/1.2rem system-ui; }'), ['font 0.8rem']);
	assert.deepEqual(raws(".a { font: 12px 'Noto Sans Medium', sans-serif; }"), ['font 12px']);
	assert.deepEqual(raws('.a { font: 12px / calc(1rem + 2px) system-ui; }'), ['font 12px']);
});

test('許可: font ショートハンドの行送りは空白を含む式でも見ない（#531 の Codex 指摘）', () => {
	const ok = [
		'.a { font: var(--banto-font-size-base)/calc(1rem + 2px) system-ui; }',
		'.a { font: var(--banto-font-size-md) / max(1.2rem, 16px) system-ui; }',
		'.a { font: 600 var(--banto-font-size-sm)/1.4rem system-ui; }'
	];
	for (const css of ok) assert.deepEqual(raws(css), [], css);
});

test('font ショートハンドは文字サイズの成分だけを見る（引用符なしのフォント名は見ない。#531 の Codex 指摘）', () => {
	const ok = [
		'.a { font: var(--banto-font-size-base) Noto Sans Medium, sans-serif; }',
		'.a { font: 600 var(--banto-font-size-sm) Hiragino Kaku Gothic ProN, Medium Large; }',
		'.a { font: var(--w) var(--banto-font-size-md)/1.5 Small Fonts; }',
		'.a { font: caption; }',
		'.a { font: italic bold smaller Arial; }',
		'.a { font: italic small-caps bold larger Medium; }',
		'.a { font: small-caps var(--banto-font-size-sm) Small Fonts, Medium; }',
		'.a { font: var(--banto-font-size-md) / 1.4 Large Type; }',
		'.a { font: inherit; }'
	];
	for (const css of ok) assert.deepEqual(raws(css), [], css);
	assert.deepEqual(raws('.a { font: bold small Arial; }'), ['font small']);
	assert.deepEqual(raws('.a { font: italic 600 large/1.2 Medium Sans; }'), ['font large']);
	assert.deepEqual(raws('.a { font: var(--w) 12px Medium Sans; }'), ['font 12px']);
	assert.deepEqual(raws('.a { font: oblique 10deg condensed 0.9rem/2 x; }'), ['font 0.9rem']);
	assert.deepEqual(raws('.a { font: calc(1rem + 2px)/1 x; }'), ['font 1rem', 'font 2px']);
});

test('文字列・url() の中の `;`・`{`・`}` で宣言を切り違えない', () => {
	assert.deepEqual(raws('.a { background: url(data:image/svg+xml;utf8,x{y}); font-size: 12px; }'), [
		'font-size 12px'
	]);
	assert.deepEqual(raws('.a { content: "a; font-size: 9px; }"; border: 1px solid; }'), [
		'border 1px'
	]);
	assert.deepEqual(raws(".a { font-family: 'x;y'; font-size: var(--banto-font-size-sm); }"), []);
});

test('違反: border・outline 系の幅', () => {
	assert.deepEqual(raws('.a { border: 1px solid var(--banto-border); }'), ['border 1px']);
	assert.deepEqual(raws('.a { border-bottom: 2px dashed red; }'), ['border-bottom 2px']);
	assert.deepEqual(raws('.a { border-inline-start: 1px solid; }'), ['border-inline-start 1px']);
	assert.deepEqual(raws('.a { border-top-width: 1px; }'), ['border-top-width 1px']);
	assert.deepEqual(raws('.a { border-width: 1px 0; }'), ['border-width 1px']);
	assert.deepEqual(raws('.a { border: thin solid; }'), ['border thin']);
	assert.deepEqual(raws('.a { outline: 2px solid var(--banto-primary); }'), ['outline 2px']);
	assert.deepEqual(raws('.a { outline-width: medium; }'), ['outline-width medium']);
	// フォーカスの輪には部品の形の縁（3px・4px）の許可を効かせない。
	assert.deepEqual(raws('.a { outline: 3px solid; }'), ['outline 3px']);
});

test('違反: 複数行の宣言・!important・@media・入れ子・トークン無しの calc', () => {
	assert.deepEqual(raws('.a {\n\tborder:\n\t\t1px\n\t\tsolid red;\n}'), ['border 1px']);
	assert.equal(findRawDimensions('.a {\n\tborder:\n\t\t1px\n\t\tsolid red;\n}')[0].line, 3);
	assert.deepEqual(raws('.a { font-size: 12px !important; }'), ['font-size 12px']);
	assert.deepEqual(raws('@media (max-width: 600px) { .a { font-size: 0.9rem } }'), [
		'font-size 0.9rem'
	]);
	assert.deepEqual(raws('.a { &:hover { border-left: 1px solid } }'), ['border-left 1px']);
	assert.deepEqual(raws(':global(.x) .a { font-size: calc(1rem * 0.9); }'), ['font-size 1rem']);
	// 最後の宣言の `;` が無くても見る。
	assert.deepEqual(raws('.a { color: red; font-size: 10px }'), ['font-size 10px']);
	assert.deepEqual(raws('font-size: 10px'), ['font-size 10px']);
});

test('許可: トークン・相対値・0・none・キーワード', () => {
	const ok = [
		'.a { font-size: var(--banto-font-size-sm); }',
		'.a { font-size: var(--banto-font-size-sm, 0.8rem); }',
		'.a { font-size: calc(var(--banto-font-size-md) * 0.9); }',
		'.a { font-size: max(var(--banto-font-size-xs), 9px); }',
		'.a { font-size: 0.9em; }',
		'.a { font-size: 90%; }',
		'.a { font-size: inherit; }',
		'.a { font-size: smaller; }',
		'.a { font: inherit; }',
		'.a { font: italic small-caps 600 var(--banto-font-size-md)/1.4 system-ui; }',
		'.a { border: var(--banto-border-width) solid var(--banto-border); }',
		'.a { border-bottom: var(--banto-border-width-strong, 2px) solid currentColor; }',
		'.a { outline: var(--banto-border-width-strong) solid var(--banto-primary); }',
		'.a { border: 0; }',
		'.a { border-width: 0px; }',
		'.a { border: none; }',
		'.a { outline: none; }',
		'.a { outline: 0; }',
		'.a { border: 0.1em solid; }',
		'.a { border-width: calc(var(--banto-border-width) * 2); }',
		// 部品の形の縁（§9: 左端の強調バーなど）。
		'.a { border-left: 3px solid var(--banto-primary); }',
		'.a { border-left-width: 4px; }'
	];
	for (const css of ok) assert.deepEqual(raws(css), [], css);
});

test('許可: 幅ではない border・outline のプロパティ（PR #530 などが使う形）', () => {
	const ok = [
		'.a { border-radius: 4px; }',
		'.a { border-radius: 999px 999px 0 0; }',
		'.a { border-top-left-radius: 6px; }',
		'.a { border-start-start-radius: 6px; }',
		'.a { border-color: var(--banto-border); }',
		'.a { border-bottom-color: #ccc; }',
		'.a { border-style: dashed; }',
		'.a { border-left-style: solid; }',
		'.a { border-collapse: collapse; }',
		'.a { border-spacing: 2px; }',
		'.a { border-image: none; }',
		'.a { outline-offset: 2px; }',
		'.a { outline-offset: -1px; }',
		'.a { outline-color: Highlight; }',
		'.a { outline-style: dashed; }',
		'.a { box-sizing: border-box; }',
		'.a { transition: border-color 120ms, outline-offset 120ms; }'
	];
	for (const css of ok) assert.deepEqual(raws(css), [], css);
});

test('許可: 余白・部品の形・コメント・セレクタは見ない', () => {
	const ok = [
		'.a { padding: 3px 6px; margin: -1px; gap: 0.35rem; }',
		'.a { width: 1px; height: 1px; } /* 1px の区切り線・sr-only は幅のプロパティでない */',
		'.a { /* font-size: 12px; border: 1px solid; */ color: red; }',
		'/* .a { font-size: 12px } */',
		'@media (max-width: 600px) { .a { padding: 2px } }',
		'.font-size\\:12px { color: red; }',
		'.a { --local-border: 1px; --banto-font-size-sm: 0.8rem; }',
		'.a { content: "font-size: 12px"; }'
	];
	for (const css of ok) assert.deepEqual(raws(css), [], css);
});

test('行番号は css の中の 1 始まり（コメントを跨いでもずれない）', () => {
	const css = '/* 1\n2 */\n.a {\n\tfont-size: 12px;\n}';
	assert.deepEqual(findRawDimensions(css), [{ line: 4, prop: 'font-size', raw: '12px' }]);
});
