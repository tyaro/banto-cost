/**
 * Template string -> AST (docs/design/report-plan.md §3.1, §3.3). Pure, DOM-free,
 * line-based recursive-descent parser for the report Markdown subset: no
 * external Markdown library, no `Date.now()`/randomness, no throwing - any
 * structural problem (unclosed `{{#each}}`, a stray `{{/if}}`, ...) is
 * recorded in `ParseResult.errors` instead so `bind()` can turn it into a
 * warning (spec: "閉じ忘れ/対応しない {{/each}} 等は AST にエラー情報を残し
 * bind 段で warning 化（throw しない）").
 *
 * Raw HTML is never recognized as syntax - `<`/`>` are always plain text
 * (escaped later in html.ts), which is how the template language closes off
 * the "template-authored HTML" XSS surface (report-plan §3.1).
 */

export type Align = 'left' | 'center' | 'right';

/** Inline (within-line) nodes. Placeholders/images can nest inside bold/italic. */
export type InlineNode =
	| { type: 'text'; value: string }
	| { type: 'bold'; children: InlineNode[] }
	| { type: 'italic'; children: InlineNode[] }
	| { type: 'image'; alt: InlineNode[]; src: InlineNode[] }
	| { type: 'placeholder'; path: string; formatter?: string };

/**
 * One row (or repeated row group) inside a table body. `each`/`if` here are
 * the "control line wraps a run of table rows" form (report-plan §3.2 example) -
 * distinct from the block-level `each`/`if` below, which wrap whole blocks.
 */
export type TableRowGroup =
	| { kind: 'row'; cells: InlineNode[][] }
	| { kind: 'each'; path: string; rows: TableRowGroup[] }
	| { kind: 'if'; path: string; rows: TableRowGroup[] };

export type BlockNode =
	| { type: 'heading'; level: 1 | 2 | 3; children: InlineNode[] }
	| { type: 'paragraph'; children: InlineNode[] }
	| { type: 'list'; items: InlineNode[][] }
	| { type: 'table'; align: Align[]; header: InlineNode[][]; rows: TableRowGroup[] }
	| { type: 'pagebreak' }
	| { type: 'each'; path: string; children: BlockNode[] }
	| { type: 'if'; path: string; children: BlockNode[] };

export interface ParseResult {
	blocks: BlockNode[];
	errors: string[];
}

const CTRL_EACH_OPEN = /^\{\{\s*#each\s+([A-Za-z0-9_.]+)\s*\}\}$/;
const CTRL_IF_OPEN = /^\{\{\s*#if\s+([A-Za-z0-9_.]+)\s*\}\}$/;
const CTRL_EACH_CLOSE = /^\{\{\s*\/each\s*\}\}$/;
const CTRL_IF_CLOSE = /^\{\{\s*\/if\s*\}\}$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const HR_RE = /^-{3,}$/;
const LIST_ITEM_RE = /^-\s+(.*)$/;
const TABLE_CELL_RE = /^:?-{2,}:?$/;

// Bold before italic (greedy `**` must win over a single `*`); image before
// placeholder; each alternative's content is non-greedy and excludes the
// character(s) that would otherwise let it swallow past its own closer.
const INLINE_RE =
	/(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)|(!\[([^\]]*)\]\(([^)]*)\))|(\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]+?)\s*)?\}\})/g;

interface ParseCtx {
	lines: string[];
	errors: string[];
}

export function parse(template: string): ParseResult {
	const ctx: ParseCtx = { lines: template.replace(/\r\n/g, '\n').split('\n'), errors: [] };
	const result = parseBlockSequence(ctx, 0, null);
	return { blocks: result.blocks, errors: ctx.errors };
}

/**
 * Parses a sequence of blocks starting at `start`. When `until` is set, this
 * is the body of a block-level `{{#each}}`/`{{#if}}` and parsing stops at a
 * matching `{{/each}}`/`{{/if}}` line (a mismatched close is reported but
 * still treated as closing the current block, to avoid runaway nesting on a
 * malformed template).
 */
function parseBlockSequence(
	ctx: ParseCtx,
	start: number,
	until: 'each' | 'if' | null
): { blocks: BlockNode[]; next: number; closed: boolean } {
	const blocks: BlockNode[] = [];
	let i = start;

	while (i < ctx.lines.length) {
		const line = ctx.lines[i].trim();

		if (line === '') {
			i++;
			continue;
		}

		const isEachClose = CTRL_EACH_CLOSE.test(line);
		const isIfClose = CTRL_IF_CLOSE.test(line);
		if (isEachClose || isIfClose) {
			const kind = isEachClose ? 'each' : 'if';
			if (until === kind) {
				return { blocks, next: i + 1, closed: true };
			}
			if (until !== null) {
				ctx.errors.push(`mismatched closing tag: expected {{/${until}}}, found {{/${kind}}}`);
				return { blocks, next: i + 1, closed: true };
			}
			ctx.errors.push(`unmatched closing tag: {{/${kind}}}`);
			i++;
			continue;
		}

		const eachOpen = CTRL_EACH_OPEN.exec(line);
		if (eachOpen) {
			const path = eachOpen[1];
			const inner = parseBlockSequence(ctx, i + 1, 'each');
			if (!inner.closed) {
				ctx.errors.push(`unclosed block: {{#each ${path}}}`);
			}
			blocks.push({ type: 'each', path, children: inner.blocks });
			i = inner.next;
			continue;
		}

		const ifOpen = CTRL_IF_OPEN.exec(line);
		if (ifOpen) {
			const path = ifOpen[1];
			const inner = parseBlockSequence(ctx, i + 1, 'if');
			if (!inner.closed) {
				ctx.errors.push(`unclosed block: {{#if ${path}}}`);
			}
			blocks.push({ type: 'if', path, children: inner.blocks });
			i = inner.next;
			continue;
		}

		const heading = HEADING_RE.exec(line);
		if (heading) {
			const level = heading[1].length as 1 | 2 | 3;
			blocks.push({ type: 'heading', level, children: parseInline(heading[2]) });
			i++;
			continue;
		}

		if (HR_RE.test(line)) {
			blocks.push({ type: 'pagebreak' });
			i++;
			continue;
		}

		if (LIST_ITEM_RE.test(line)) {
			const items: InlineNode[][] = [];
			while (i < ctx.lines.length) {
				const t = ctx.lines[i].trim();
				const m = LIST_ITEM_RE.exec(t);
				if (!m) break;
				items.push(parseInline(m[1]));
				i++;
			}
			blocks.push({ type: 'list', items });
			continue;
		}

		if (line.startsWith('|')) {
			const sepLine = i + 1 < ctx.lines.length ? ctx.lines[i + 1].trim() : '';
			const align = parseTableSeparator(sepLine);
			if (align) {
				const header = splitCells(line).map(parseInline);
				const rows = parseTableBody(ctx, i + 2);
				blocks.push({
					type: 'table',
					align: normalizeAlign(align, header.length),
					header,
					rows: rows.rows
				});
				i = rows.next;
				continue;
			}
			// No valid separator on the next line: not a table, falls through
			// to paragraph handling below (spec: "セパレータ無しの | 行群は
			// 通常段落扱い").
		}

		// Paragraph: absorb consecutive plain lines until a blank line or the
		// start of another block construct.
		const paraLines: string[] = [];
		while (i < ctx.lines.length) {
			const t = ctx.lines[i].trim();
			if (t === '') break;
			if (CTRL_EACH_CLOSE.test(t) || CTRL_IF_CLOSE.test(t)) break;
			if (CTRL_EACH_OPEN.test(t) || CTRL_IF_OPEN.test(t)) break;
			if (HEADING_RE.test(t)) break;
			if (HR_RE.test(t)) break;
			if (LIST_ITEM_RE.test(t)) break;
			if (t.startsWith('|')) {
				const sep = i + 1 < ctx.lines.length ? ctx.lines[i + 1].trim() : '';
				if (parseTableSeparator(sep)) break;
			}
			paraLines.push(t);
			i++;
		}
		blocks.push({ type: 'paragraph', children: parseInline(paraLines.join(' ')) });
	}

	return { blocks, next: i, closed: until === null };
}

/**
 * Parses table row groups: plain `| a | b |` rows, and `{{#each}}`/`{{#if}}`
 * control lines that wrap a nested run of rows (recursing into this same
 * function, so nested `each`-in-`each` row groups work). A control line is
 * only treated as a row-repeat when the very next line is itself a row or
 * another control line - otherwise it belongs to the surrounding block-level
 * parser and the table simply ends here.
 */
function parseTableBody(ctx: ParseCtx, start: number): { rows: TableRowGroup[]; next: number } {
	const rows: TableRowGroup[] = [];
	let i = start;

	while (i < ctx.lines.length) {
		const line = ctx.lines[i].trim();
		if (line === '') break;

		if (CTRL_EACH_CLOSE.test(line) || CTRL_IF_CLOSE.test(line)) {
			// Belongs to an enclosing group - let the caller consume it.
			break;
		}

		const eachOpen = CTRL_EACH_OPEN.exec(line);
		const ifOpen = CTRL_IF_OPEN.exec(line);
		if (eachOpen || ifOpen) {
			const nextLine = i + 1 < ctx.lines.length ? ctx.lines[i + 1].trim() : '';
			const isRowRepeat =
				nextLine.startsWith('|') || CTRL_EACH_OPEN.test(nextLine) || CTRL_IF_OPEN.test(nextLine);
			if (!isRowRepeat) break;

			const kind: 'each' | 'if' = eachOpen ? 'each' : 'if';
			const path = (eachOpen ?? ifOpen)![1];
			const inner = parseTableBody(ctx, i + 1);

			const closeIdx = inner.next;
			const closeLine = closeIdx < ctx.lines.length ? ctx.lines[closeIdx].trim() : '';
			const closesEach = CTRL_EACH_CLOSE.test(closeLine);
			const closesIf = CTRL_IF_CLOSE.test(closeLine);

			let next: number;
			if ((kind === 'each' && closesEach) || (kind === 'if' && closesIf)) {
				next = closeIdx + 1;
			} else if (closesEach || closesIf) {
				ctx.errors.push(
					`mismatched closing tag: expected {{/${kind}}}, found {{/${closesEach ? 'each' : 'if'}}}`
				);
				next = closeIdx + 1;
			} else {
				ctx.errors.push(`unclosed block: {{#${kind} ${path}}}`);
				next = closeIdx;
			}

			rows.push({ kind, path, rows: inner.rows });
			i = next;
			continue;
		}

		if (line.startsWith('|')) {
			rows.push({ kind: 'row', cells: splitCells(line).map(parseInline) });
			i++;
			continue;
		}

		break;
	}

	return { rows, next: i };
}

/**
 * Splits `| a | b |` into `['a', 'b']`, trimmed, leading/trailing `|`
 * optional. Brace-aware: a `|` inside `{{ ... }}` (the formatter pipe, e.g.
 * `{{ stock | number }}`) never counts as a cell separator.
 */
function splitCells(line: string): string[] {
	let s = line.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|')) s = s.slice(0, -1);

	const cells: string[] = [];
	let current = '';
	let inPlaceholder = false;
	for (let i = 0; i < s.length; i++) {
		const two = s.slice(i, i + 2);
		if (!inPlaceholder && two === '{{') {
			inPlaceholder = true;
			current += two;
			i++;
			continue;
		}
		if (inPlaceholder && two === '}}') {
			inPlaceholder = false;
			current += two;
			i++;
			continue;
		}
		if (s[i] === '|' && !inPlaceholder) {
			cells.push(current.trim());
			current = '';
			continue;
		}
		current += s[i];
	}
	cells.push(current.trim());
	return cells;
}

/** Returns column alignments if `line` is a valid table separator row, else null. */
function parseTableSeparator(line: string): Align[] | null {
	if (!line.startsWith('|')) return null;
	const cells = splitCells(line);
	if (cells.length === 0) return null;
	const aligns: Align[] = [];
	for (const cell of cells) {
		if (!TABLE_CELL_RE.test(cell)) return null;
		const left = cell.startsWith(':');
		const right = cell.endsWith(':');
		aligns.push(left && right ? 'center' : right ? 'right' : 'left');
	}
	return aligns;
}

function normalizeAlign(align: Align[], len: number): Align[] {
	const result = align.slice(0, len);
	while (result.length < len) result.push('left');
	return result;
}

/** Parses inline markup (bold/italic/image/placeholder) within one logical line of text. */
export function parseInline(text: string): InlineNode[] {
	const nodes: InlineNode[] = [];
	let lastIndex = 0;
	// A fresh RegExp per call, NOT the shared module-level object: this
	// function recurses (bold/italic/image children), and a recursive call
	// resetting the shared regex's `lastIndex` would make the outer exec()
	// loop restart at 0 and re-match the same span forever.
	const re = new RegExp(INLINE_RE.source, 'g');
	let match: RegExpExecArray | null;

	while ((match = re.exec(text)) !== null) {
		if (match.index > lastIndex) {
			nodes.push({ type: 'text', value: text.slice(lastIndex, match.index) });
		}
		if (match[1] !== undefined) {
			nodes.push({ type: 'bold', children: parseInline(match[2]) });
		} else if (match[3] !== undefined) {
			nodes.push({ type: 'italic', children: parseInline(match[4]) });
		} else if (match[5] !== undefined) {
			nodes.push({ type: 'image', alt: parseInline(match[6]), src: parseInline(match[7]) });
		} else if (match[8] !== undefined) {
			nodes.push({ type: 'placeholder', path: match[9].trim(), formatter: match[10]?.trim() });
		}
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < text.length) {
		nodes.push({ type: 'text', value: text.slice(lastIndex) });
	}
	return nodes;
}
