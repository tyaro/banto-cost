/**
 * AST + data -> resolved AST (docs/design/report-plan.md §3.2, §3.3). Expands
 * `{{#each}}`/`{{#if}}` (block-level and table-row-group forms), resolves
 * `{{ path }}` placeholders against the data, and applies formatters. Pure
 * and DOM-free; values are formatted but not HTML-escaped here - html.ts
 * escapes everything on the way out.
 */

import type { Align, BlockNode, InlineNode, ParseResult, TableRowGroup } from './parse';

export type ResolvedInline =
	| { type: 'text'; value: string }
	| { type: 'bold'; children: ResolvedInline[] }
	| { type: 'italic'; children: ResolvedInline[] }
	| { type: 'image'; alt: string; src: string };

export type ResolvedBlock =
	| { type: 'heading'; level: 1 | 2 | 3; children: ResolvedInline[] }
	| { type: 'paragraph'; children: ResolvedInline[] }
	| { type: 'list'; items: ResolvedInline[][] }
	| { type: 'table'; align: Align[]; header: ResolvedInline[][]; rows: ResolvedInline[][][] }
	| { type: 'pagebreak' };

export interface BindResult {
	blocks: ResolvedBlock[];
	warnings: string[];
}

export type Formatter = (value: unknown) => string;
export type FormatterMap = Record<string, Formatter>;

/** Default formatters (report-plan §3.2): `yen`, `number`, `date`. */
export const DEFAULT_FORMATTERS: FormatterMap = {
	yen: formatYen,
	number: formatNumber,
	date: formatDate
};

function formatYen(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return `¥${value.toLocaleString()}`;
	}
	return String(value);
}

function formatNumber(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value.toLocaleString();
	}
	return String(value);
}

function formatDate(value: unknown): string {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return String(value);
		return toYmd(value.getFullYear(), value.getMonth() + 1, value.getDate());
	}
	if (typeof value === 'string') {
		// Match a leading YYYY-MM-DD directly (avoids timezone drift from
		// parsing a date-only ISO string via `new Date(...)`, which JS treats
		// as UTC midnight).
		const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
		if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return toYmd(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
		}
	}
	return String(value);
}

function toYmd(y: number, m: number, d: number): string {
	return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `undefined`/`null` -> `''`; anything else -> `String(value)`. Used for unformatted placeholders. */
function valueToText(value: unknown): string {
	if (value === undefined || value === null) return '';
	return String(value);
}

/** JS truthy, except an empty array is falsy (spec: report "no data" branches via `{{#if}}`). */
function isTruthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return Boolean(value);
}

/**
 * Resolves a dot-path against `scope`. Inside an `{{#each}}`, `scope` is the
 * current element (v1 has no `../` - paths never escape to an outer scope,
 * see docs/design/report-plan.md §3.2/§3.3). `.` refers to `scope` itself, which is
 * how a primitive-array `{{#each}}` (`{{ . }}`) works.
 */
function resolvePath(scope: unknown, path: string): { found: boolean; value: unknown } {
	if (path === '.') {
		return { found: scope !== undefined, value: scope };
	}
	let cur: unknown = scope;
	for (const part of path.split('.')) {
		if (cur === null || typeof cur !== 'object') {
			return { found: false, value: undefined };
		}
		// Own properties only: `in` would walk the prototype chain and
		// "resolve" e.g. `{{ toString }}` to Object.prototype.toString.
		if (!Object.prototype.hasOwnProperty.call(cur, part)) {
			return { found: false, value: undefined };
		}
		cur = (cur as Record<string, unknown>)[part];
	}
	return { found: true, value: cur };
}

export function bind(
	parsed: ParseResult,
	data: unknown,
	options: { formatters?: FormatterMap } = {}
): BindResult {
	const warnings = new Set<string>();
	for (const error of parsed.errors) warnings.add(error);

	const formatters: FormatterMap = { ...DEFAULT_FORMATTERS, ...(options.formatters ?? {}) };
	const blocks = bindBlocks(parsed.blocks, data, formatters, warnings);
	return { blocks, warnings: Array.from(warnings) };
}

function bindBlocks(
	blocks: BlockNode[],
	scope: unknown,
	formatters: FormatterMap,
	warnings: Set<string>
): ResolvedBlock[] {
	const out: ResolvedBlock[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case 'heading':
				out.push({
					type: 'heading',
					level: block.level,
					children: bindInline(block.children, scope, formatters, warnings)
				});
				break;
			case 'paragraph':
				out.push({
					type: 'paragraph',
					children: bindInline(block.children, scope, formatters, warnings)
				});
				break;
			case 'list':
				out.push({
					type: 'list',
					items: block.items.map((item) => bindInline(item, scope, formatters, warnings))
				});
				break;
			case 'pagebreak':
				out.push({ type: 'pagebreak' });
				break;
			case 'table':
				out.push({
					type: 'table',
					align: block.align,
					header: block.header.map((cell) => bindInline(cell, scope, formatters, warnings)),
					rows: bindTableRows(block.rows, scope, formatters, warnings)
				});
				break;
			case 'each': {
				const { found, value } = resolvePath(scope, block.path);
				if (!found) warnings.add(`unresolved path: ${block.path}`);
				if (Array.isArray(value)) {
					const expanded: ResolvedBlock[] = [];
					for (const item of value) {
						expanded.push(...bindBlocks(block.children, item, formatters, warnings));
					}
					// Markdown semantics: consecutive `- ` lines are ONE list, and
					// each-expansion multiplies lines - so adjacent list blocks
					// produced by the same expansion merge into a single list
					// (mirrors how table row-repeat accumulates rows in one
					// table). Lists outside the expansion are never merged into.
					out.push(...mergeAdjacentLists(expanded));
				}
				break;
			}
			case 'if': {
				const { found, value } = resolvePath(scope, block.path);
				if (!found) warnings.add(`unresolved path: ${block.path}`);
				if (isTruthy(value)) {
					out.push(...bindBlocks(block.children, scope, formatters, warnings));
				}
				break;
			}
		}
	}
	return out;
}

/** Merges runs of adjacent resolved list blocks into one list (see the `each` case above). */
function mergeAdjacentLists(blocks: ResolvedBlock[]): ResolvedBlock[] {
	const out: ResolvedBlock[] = [];
	for (const block of blocks) {
		const prev = out[out.length - 1];
		if (block.type === 'list' && prev?.type === 'list') {
			prev.items.push(...block.items);
			continue;
		}
		out.push(block);
	}
	return out;
}

function bindTableRows(
	rows: TableRowGroup[],
	scope: unknown,
	formatters: FormatterMap,
	warnings: Set<string>
): ResolvedInline[][][] {
	const out: ResolvedInline[][][] = [];
	for (const row of rows) {
		if (row.kind === 'row') {
			out.push(row.cells.map((cell) => bindInline(cell, scope, formatters, warnings)));
			continue;
		}
		const { found, value } = resolvePath(scope, row.path);
		if (!found) warnings.add(`unresolved path: ${row.path}`);
		if (row.kind === 'each') {
			if (Array.isArray(value)) {
				for (const item of value) {
					out.push(...bindTableRows(row.rows, item, formatters, warnings));
				}
			}
		} else if (isTruthy(value)) {
			out.push(...bindTableRows(row.rows, scope, formatters, warnings));
		}
	}
	return out;
}

function bindInline(
	nodes: InlineNode[],
	scope: unknown,
	formatters: FormatterMap,
	warnings: Set<string>
): ResolvedInline[] {
	return nodes.map((node): ResolvedInline => {
		switch (node.type) {
			case 'text':
				return { type: 'text', value: node.value };
			case 'bold':
				return { type: 'bold', children: bindInline(node.children, scope, formatters, warnings) };
			case 'italic':
				return {
					type: 'italic',
					children: bindInline(node.children, scope, formatters, warnings)
				};
			case 'image':
				return {
					type: 'image',
					alt: inlineToPlainText(bindInline(node.alt, scope, formatters, warnings)),
					src: inlineToPlainText(bindInline(node.src, scope, formatters, warnings))
				};
			case 'placeholder': {
				const { found, value } = resolvePath(scope, node.path);
				if (!found) {
					warnings.add(`unresolved path: ${node.path}`);
					return { type: 'text', value: '' };
				}
				if (node.formatter) {
					const fmt = formatters[node.formatter];
					if (!fmt) {
						warnings.add(`unknown formatter: ${node.formatter}`);
						return { type: 'text', value: valueToText(value) };
					}
					return { type: 'text', value: fmt(value) };
				}
				return { type: 'text', value: valueToText(value) };
			}
		}
	});
}

/** Flattens resolved inline nodes to plain text (bold/italic unwrapped) for image src/alt attributes. */
function inlineToPlainText(nodes: ResolvedInline[]): string {
	return nodes
		.map((n) => {
			if (n.type === 'text') return n.value;
			if (n.type === 'image') return n.alt;
			return inlineToPlainText(n.children);
		})
		.join('');
}
