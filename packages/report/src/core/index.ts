/**
 * `renderReport` - the headless report core's public entry point
 * (docs/design/report-plan.md §3.3). Wires parse -> bind -> html together and
 * merges warnings from all three stages (deduped, insertion order).
 */

import { bind } from './bind';
import { renderHtml } from './html';
import { parse } from './parse';

export interface RenderOptions {
	/** Additional/overriding formatters. Defaults: `yen` / `number` / `date`. */
	formatters?: Record<string, (value: unknown) => string>;
}

export interface RenderResult {
	html: string;
	warnings: string[];
}

export function renderReport(
	template: string,
	data: unknown,
	options: RenderOptions = {}
): RenderResult {
	const parsed = parse(template);
	const bound = bind(parsed, data, { formatters: options.formatters });
	const rendered = renderHtml(bound.blocks);
	const warnings = Array.from(new Set([...bound.warnings, ...rendered.warnings]));
	return { html: rendered.html, warnings };
}
