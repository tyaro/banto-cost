/**
 * Resolved AST -> HTML string (docs/design/report-plan.md §3.3). Every text value
 * and attribute is escaped without exception - data-value text and
 * template-authored text go through the exact same path, so there is no
 * "trusted" string anywhere in this module (report-plan §3.1/§3.2 XSS closure).
 */

import type { Align } from './parse';
import type { ResolvedBlock, ResolvedInline } from './bind';

export interface HtmlResult {
	html: string;
	warnings: string[];
}

export function renderHtml(blocks: ResolvedBlock[]): HtmlResult {
	const warnings: string[] = [];
	const body = blocks.map((block) => renderBlock(block, warnings)).join('');
	return { html: `<div class="report-body">${body}</div>`, warnings };
}

function renderBlock(block: ResolvedBlock, warnings: string[]): string {
	switch (block.type) {
		case 'heading': {
			const tag = `h${block.level}`;
			return `<${tag}>${renderInline(block.children, warnings)}</${tag}>`;
		}
		case 'paragraph':
			return `<p>${renderInline(block.children, warnings)}</p>`;
		case 'list':
			return `<ul>${block.items
				.map((item) => `<li>${renderInline(item, warnings)}</li>`)
				.join('')}</ul>`;
		case 'pagebreak':
			return `<hr class="report-page-break">`;
		case 'table': {
			const thead = block.header
				.map(
					(cell, idx) => `<th${alignAttr(block.align[idx])}>${renderInline(cell, warnings)}</th>`
				)
				.join('');
			const tbody = block.rows
				.map(
					(row) =>
						`<tr>${row
							.map(
								(cell, idx) =>
									`<td${alignAttr(block.align[idx])}>${renderInline(cell, warnings)}</td>`
							)
							.join('')}</tr>`
				)
				.join('');
			return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
		}
	}
}

function alignAttr(align: Align | undefined): string {
	if (align === 'right') return ' class="report-align-right"';
	if (align === 'center') return ' class="report-align-center"';
	return '';
}

function renderInline(nodes: ResolvedInline[], warnings: string[]): string {
	return nodes
		.map((node) => {
			switch (node.type) {
				case 'text':
					return escapeHtml(node.value);
				case 'bold':
					return `<strong>${renderInline(node.children, warnings)}</strong>`;
				case 'italic':
					return `<em>${renderInline(node.children, warnings)}</em>`;
				case 'image': {
					let src = node.src;
					if (isUnsafeSrc(src)) {
						warnings.push(`unsafe image src blocked: ${src}`);
						src = '';
					}
					return `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.alt)}">`;
				}
			}
		})
		.join('');
}

/** Blocks `javascript:` (and surrounding whitespace/case variants) image sources. */
function isUnsafeSrc(src: string): boolean {
	return /^\s*javascript:/i.test(src);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
