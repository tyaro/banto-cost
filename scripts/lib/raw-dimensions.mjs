/**
 * 文字サイズと枠線幅の生値の検出（conventions §9、theme-dimension-tokens.md §7 D8）。
 *
 * `scripts/verify-architecture.mjs` の rule `raw-dimensions` が使う小さな純粋関数。
 * CSS の本文（`.svelte` の `<style>` の中身、または `.css` ファイル）を受け取り、
 * 次の宣言の値に残っている生の寸法を返す。余白（gap / padding / margin など）は
 * `em`・`calc()`・部品の形の例外が多く誤検知が多いので見ない（D8-b）。
 *
 * - 文字サイズ: `font-size`、`font`（ショートハンド。文字サイズの成分だけを見て、`/` の後の行送りとフォント名は見ない）。
 *   絶対の長さ（`px`・`rem`・`pt`・`mm` など）と絶対キーワード（`small`・`large` など）。
 * - 枠線幅: `border`、`border-{top,right,bottom,left,block,inline}[-{start,end}]`、
 *   それぞれの `-width`、`border-width`、`outline`、`outline-width`、`column-rule[-width]`。
 *   絶対の長さと `thin`・`medium`・`thick`。`border-radius`・`border-color`・
 *   `border-style`・`border-collapse`・`border-spacing`・`outline-offset` などは
 *   幅ではないので見ない。
 *
 * 許可する（検出しない）もの: `0`（単位付きの `0px` も）、`border` 系の `3px`・`4px`
 * （強調の縁。§9 で部品の形として扱う。`outline` には効かせない）、`none`・`inherit` などの
 * キーワード、`em`・`%`・`smaller`/`larger` などの相対値、`var(...)`（フォールバックを
 * 含めて丸ごと）、`--banto-*` トークンを使う `calc()`/`min()`/`max()`/`clamp()`。
 * コメント（`/* … *\/`）の中は見ない。複数行にまたがる宣言、`!important`、
 * `@media` などの入れ子の中も同じように見る。
 *
 * 依存を足さない文化（conventions §3）に従い Node 標準のみ（ここでは何も import しない）。
 */

/** 文字サイズとして見るプロパティ。 */
const FONT_PROPS = /^(?:font-size|font)$/;

/** 枠線幅として見るプロパティ（幅を持つもののみ。radius・color・style などは含めない）。 */
const BORDER_PROPS =
	/^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-width)?|outline(?:-width)?|column-rule(?:-width)?)$/;

/** 絶対の長さ（相対の `em`・`%`・`ch` などは含めない）。 */
const ABS_LENGTH =
	/(?<![\w.#-])[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|pt|pc|mm|cm|in|q|vw|vh|vmin|vmax)(?![\w-])/gi;

/** 文字サイズの絶対キーワード（`smaller`・`larger` は相対なので含めない）。 */
const FONT_KEYWORDS =
	/(?<![\w-])(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)(?![\w-])/gi;

/** 枠線幅のキーワード。 */
const BORDER_KEYWORDS = /(?<![\w-])(?:thin|medium|thick)(?![\w-])/gi;

/**
 * 部品の形として許可する縁の幅（conventions §9「`3px`・`4px` の縁（左端の強調バーなど）。
 * 部品の形として扱う」、theme-dimension-tokens.md §5.2）。`border` 系だけに効かせ、
 * `outline`（フォーカスの輪）には効かせない。
 */
const SHAPE_EDGE_WIDTHS = new Set(['3px', '4px']);

/** 数値が 0 か（`0`・`0px`・`-0.0rem` など）。 */
const isZero = (token) => /^[+-]?(?:0+\.?0*|\.0+)[a-z]*$/i.test(token);

/** コメントを同じ長さの空白に置き換える（改行は残し、行番号と位置をずらさない）。 */
export function blankComments(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/**
 * `name(` で始まる関数呼び出しを、括弧の対応をとって取り除く。`keep(inner)` が
 * true を返すものは残す。取り除いた所は空白で埋める（位置は使わないが念のため）。
 */
function removeCalls(value, names, drop) {
	const re = new RegExp(`(?<![\\w-])(?:${names})\\(`, 'gi');
	let out = '';
	let i = 0;
	for (let m = re.exec(value); m; m = re.exec(value)) {
		if (m.index < i) continue;
		let depth = 0;
		let j = m.index + m[0].length - 1;
		for (; j < value.length; j++) {
			if (value[j] === '(') depth++;
			else if (value[j] === ')' && --depth === 0) break;
		}
		const call = value.slice(m.index, j + 1);
		out += value.slice(i, m.index);
		out += drop(call) ? ' '.repeat(call.length) : call;
		i = j + 1;
		re.lastIndex = i;
	}
	return out + value.slice(i);
}

/** 値から、トークンとして許可する部分（`var()`・トークンを使う計算関数）を除く。 */
function stripAllowed(value) {
	// トークンを使う calc/min/max/clamp は丸ごと許可（部品の形からの導出を含む）。
	const v = removeCalls(value, 'calc|min|max|clamp', (call) => /var\(\s*--banto-/i.test(call));
	// var() はフォールバックを含めて丸ごと除く（入れ子の var も外側ごと消える）。
	return removeCalls(v, 'var', () => true);
}

/** 長さを保ったまま空白にする（改行は残し、行番号と位置をずらさない）。 */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** `font` ショートハンドで文字サイズより前に来てよい語（style・variant・weight・stretch）。 */
const FONT_PREFIX =
	/^(?:normal|italic|oblique|small-caps|bold|bolder|lighter|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|grad|rad|turn)?)$/i;

/** 文字サイズの成分らしい先頭（長さ・パーセント・キーワード・関数）。 */
const FONT_SIZE_LIKE =
	/^(?:[+-]?(?:\d|\.\d)|[a-z-]+\(|(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\/|$))/i;

/** 最上位（括弧の外）の空白で区切った語と、その位置。 */
function topLevelTokens(value) {
	const tokens = [];
	let depth = 0;
	let start = -1;
	for (let i = 0; i <= value.length; i++) {
		const ch = value[i];
		const sep = i === value.length || (depth === 0 && /\s/.test(ch));
		if (!sep) {
			if (start < 0) start = i;
			if (ch === '(') depth++;
			else if (ch === ')') depth = Math.max(0, depth - 1);
		} else if (start >= 0) {
			tokens.push({ text: value.slice(start, i), start });
			start = -1;
		}
	}
	return tokens;
}

/**
 * `font` ショートハンドから文字サイズの成分だけを残し、ほかを空白にする。行送り（`/` の後）と
 * フォント名（引用符なしの `Noto Sans Medium` など）は §9 の寸法に含めないので見ない。
 * 文字サイズより前の style・weight などは飛ばし、`var()`（weight かもしれない）も飛ばす。
 * 次の語が長さ・キーワード・関数なら、それが文字サイズ。それ以外の語が来たらフォント名が
 * 始まったとみなし、文字サイズは `var()` だった（＝許可）とする。
 */
function fontSizePart(value) {
	let afterVar = false;
	for (const { text, start } of topLevelTokens(value)) {
		// `/` で始まる語は行送り。その前の語（`var()`）が文字サイズだった。
		if (text.startsWith('/')) break;
		if (/^var\(/i.test(text)) {
			// `var(--size)/1.5` のように最上位に `/` を持つ var は文字サイズそのもの（＝許可）。
			if (/^var\((?:[^()]|\([^()]*\))*\)\s*\//i.test(text)) break;
			afterVar = true;
			continue;
		}
		if (FONT_PREFIX.test(text)) continue;
		if (!FONT_SIZE_LIKE.test(text)) break;
		// var() の後の語は、var が文字サイズだった場合はフォント名の始まり（`Small Fonts`・
		// `Medium` など）。キーワードは見分けられないので、誤検知を避けてフォント名とみなす
		// （`var(--weight) small Arial` の `small` は見逃す。長さ・関数は引き続き見る）。
		if (afterVar && /^[a-z]/i.test(text) && !/^[a-z-]+\(/i.test(text)) break;
		// 語の中の最上位の `/` から後ろ（行送り）は落とす。
		let end = text.length;
		for (let i = 0, depth = 0; i < text.length; i++) {
			if (text[i] === '(') depth++;
			else if (text[i] === ')') depth--;
			else if (text[i] === '/' && depth === 0) {
				end = i;
				break;
			}
		}
		return blank(value.slice(0, start)) + text.slice(0, end) + blank(value.slice(start + end));
	}
	return blank(value);
}

/**
 * CSS の本文から、文字サイズと枠線幅の生値を探す。
 *
 * @param {string} css `<style>` の中身か `.css` ファイルの本文
 * @returns {{ line: number, prop: string, raw: string }[]} `line` は `css` の中の 1 始まりの行
 */
export function findRawDimensions(css) {
	// コメント → 文字列 → url() の中身の順に空白にする。文字列や data URI の中の `;`・`{`・`}`
	// で宣言を切り違えないため（フォント名や `content` の文字列の中も見ない）。
	const src = blankComments(css)
		.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, blank)
		.replace(/(?<![\w-])url\([^)]*\)/gi, blank);
	const hits = [];
	// 宣言は `;` か `}` で終わる区間。`{` で終わる区間はセレクタ・@規則なので見ない。
	let start = 0;
	for (let i = 0; i <= src.length; i++) {
		const ch = src[i];
		if (ch !== ';' && ch !== '}' && ch !== '{' && i !== src.length) continue;
		const seg = src.slice(start, i);
		const segStart = start;
		start = i + 1;
		if (ch === '{') continue;
		const colon = seg.indexOf(':');
		if (colon < 0) continue;
		const prop = seg.slice(0, colon).trim().toLowerCase();
		const isFont = FONT_PROPS.test(prop);
		const isBorder = !isFont && BORDER_PROPS.test(prop);
		if (!isFont && !isBorder) continue;
		// `font` ショートハンドは文字サイズの成分だけを見る（行送り・フォント名は見ない）。
		const raw = seg.slice(colon + 1);
		const value = stripAllowed(prop === 'font' ? fontSizePart(raw) : raw);
		const valueStart = segStart + colon + 1;
		const patterns = [ABS_LENGTH, isFont ? FONT_KEYWORDS : BORDER_KEYWORDS];
		for (const re of patterns) {
			for (const m of value.matchAll(re)) {
				if (isZero(m[0])) continue;
				if (isBorder && prop.startsWith('border') && SHAPE_EDGE_WIDTHS.has(m[0].toLowerCase()))
					continue;
				const line = src.slice(0, valueStart + m.index).split('\n').length;
				hits.push({ line, prop, raw: m[0] });
			}
		}
	}
	return hits.sort((a, b) => a.line - b.line);
}
