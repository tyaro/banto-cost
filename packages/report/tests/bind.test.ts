import { describe, expect, it } from 'vitest';
import { bind, DEFAULT_FORMATTERS } from '../src/core/bind';
import { parse } from '../src/core/parse';

/** Convenience: parse + bind a template in one call for readable fixtures. */
function bindTemplate(
	template: string,
	data: unknown,
	formatters?: Record<string, (v: unknown) => string>
) {
	return bind(parse(template), data, { formatters });
}

describe('bind - path resolution', () => {
	it('resolves a dotted path from the root scope', () => {
		const result = bindTemplate('{{ shop.name }}', { shop: { name: 'Banto' } });
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'Banto' }] }
		]);
		expect(result.warnings).toEqual([]);
	});

	it('resolves an undefined path to empty text and records a deduped warning', () => {
		const result = bindTemplate('{{ missing.a }} and {{ missing.a }} again', {});
		expect(result.blocks).toEqual([
			{
				type: 'paragraph',
				children: [
					{ type: 'text', value: '' },
					{ type: 'text', value: ' and ' },
					{ type: 'text', value: '' },
					{ type: 'text', value: ' again' }
				]
			}
		]);
		expect(result.warnings).toEqual(['unresolved path: missing.a']);
	});
});

describe('bind - each (block level)', () => {
	it('repeats list items over an array of objects', () => {
		const result = bindTemplate('{{#each items}}\n- {{ name }}\n{{/each}}', {
			items: [{ name: 'A' }, { name: 'B' }]
		});
		// Markdown semantics: the expansion yields consecutive `- ` items,
		// which belong to ONE list (mirrors the table row-repeat accumulating
		// rows in one table).
		expect(result.blocks).toEqual([
			{ type: 'list', items: [[{ type: 'text', value: 'A' }], [{ type: 'text', value: 'B' }]] }
		]);
	});

	it('supports a primitive array with `{{ . }}`', () => {
		const result = bindTemplate('{{#each tags}}\n- {{ . }}\n{{/each}}', { tags: ['red', 'blue'] });
		expect(result.blocks).toEqual([
			{
				type: 'list',
				items: [[{ type: 'text', value: 'red' }], [{ type: 'text', value: 'blue' }]]
			}
		]);
	});

	it('produces no rows for an empty array', () => {
		const result = bindTemplate('{{#each items}}\n- {{ name }}\n{{/each}}', { items: [] });
		expect(result.blocks).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('supports nested each (departments -> staff)', () => {
		const template =
			'{{#each departments}}\n## {{ name }}\n{{#each staff}}\n- {{ . }}\n{{/each}}\n{{/each}}';
		const data = {
			departments: [
				{ name: 'Sales', staff: ['Ann', 'Bob'] },
				{ name: 'Ops', staff: ['Cy'] }
			]
		};
		const result = bindTemplate(template, data);
		expect(result.blocks).toEqual([
			{ type: 'heading', level: 2, children: [{ type: 'text', value: 'Sales' }] },
			{ type: 'list', items: [[{ type: 'text', value: 'Ann' }], [{ type: 'text', value: 'Bob' }]] },
			{ type: 'heading', level: 2, children: [{ type: 'text', value: 'Ops' }] },
			{ type: 'list', items: [[{ type: 'text', value: 'Cy' }]] }
		]);
	});

	it('does not fall back to an outer scope inside a nested each (v1: no parent references)', () => {
		// `shopName` only exists at the root, not inside each `items` element -
		// it must resolve to empty + a warning, not leak through from the outer scope.
		const result = bindTemplate('{{#each items}}\n- {{ shopName }}\n{{/each}}', {
			shopName: 'Banto',
			items: [{ name: 'A' }]
		});
		expect(result.blocks).toEqual([{ type: 'list', items: [[{ type: 'text', value: '' }]] }]);
		expect(result.warnings).toEqual(['unresolved path: shopName']);
	});
});

describe('bind - each (table row-repeat)', () => {
	it('repeats table rows over an array (plan §3.2 low-stock example)', () => {
		const template = [
			'| 商品名 | 在庫 |',
			'|---|---:|',
			'{{#each lowStock}}',
			'| {{ name }} | {{ stock | number }} |',
			'{{/each}}'
		].join('\n');
		const result = bindTemplate(template, {
			lowStock: [
				{ name: 'ねじ', stock: 3 },
				{ name: 'ボルト', stock: 12 }
			]
		});
		expect(result.blocks).toEqual([
			{
				type: 'table',
				align: ['left', 'right'],
				header: [[{ type: 'text', value: '商品名' }], [{ type: 'text', value: '在庫' }]],
				rows: [
					[[{ type: 'text', value: 'ねじ' }], [{ type: 'text', value: (3).toLocaleString() }]],
					[[{ type: 'text', value: 'ボルト' }], [{ type: 'text', value: (12).toLocaleString() }]]
				]
			}
		]);
	});

	it('produces no data rows (but keeps the table/header) for an empty array', () => {
		const template = ['| Name |', '|---|', '{{#each items}}', '| {{ name }} |', '{{/each}}'].join(
			'\n'
		);
		const result = bindTemplate(template, { items: [] });
		expect(result.blocks).toEqual([
			{
				type: 'table',
				align: ['left'],
				header: [[{ type: 'text', value: 'Name' }]],
				rows: []
			}
		]);
	});

	it('supports nested each row groups inside a table', () => {
		// v1 scoping: inside `{{#each items}}` the scope is the item itself -
		// there are NO parent references (see the block-level test above), so
		// the category label lives on its own group-header row bound in the
		// OUTER scope, and item rows only use `{{ . }}`. This is the intended
		// row-group pattern for 帳票 (category header + detail rows).
		const template = [
			'| Category | Item |',
			'|---|---|',
			'{{#each categories}}',
			'| **{{ category }}** | |',
			'{{#each items}}',
			'| | {{ . }} |',
			'{{/each}}',
			'{{/each}}'
		].join('\n');
		const result = bindTemplate(template, {
			categories: [
				{ category: 'Fruit', items: ['Apple', 'Pear'] },
				{ category: 'Veg', items: ['Carrot'] }
			]
		});
		const table = result.blocks[0];
		if (table.type !== 'table') throw new Error('expected table');
		expect(table.rows).toEqual([
			[[{ type: 'bold', children: [{ type: 'text', value: 'Fruit' }] }], []],
			[[], [{ type: 'text', value: 'Apple' }]],
			[[], [{ type: 'text', value: 'Pear' }]],
			[[{ type: 'bold', children: [{ type: 'text', value: 'Veg' }] }], []],
			[[], [{ type: 'text', value: 'Carrot' }]]
		]);
	});
});

describe('bind - if', () => {
	it('includes the block when the path is truthy', () => {
		const result = bindTemplate('{{#if hasNotes}}\nSee notes.\n{{/if}}', { hasNotes: true });
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'See notes.' }] }
		]);
	});

	it('omits the block when the path is falsy', () => {
		const result = bindTemplate('{{#if hasNotes}}\nSee notes.\n{{/if}}', { hasNotes: false });
		expect(result.blocks).toEqual([]);
	});

	it('treats an empty array as falsy', () => {
		const result = bindTemplate('{{#if lowStock}}\nRestock needed.\n{{/if}}', { lowStock: [] });
		expect(result.blocks).toEqual([]);
	});

	it('treats a non-empty array as truthy', () => {
		const result = bindTemplate('{{#if lowStock}}\nRestock needed.\n{{/if}}', {
			lowStock: [{ name: 'x' }]
		});
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'Restock needed.' }] }
		]);
	});

	it('nests if inside each', () => {
		const template = '{{#each items}}\n{{#if lowStock}}\n- {{ name }}\n{{/if}}\n{{/each}}';
		const result = bindTemplate(template, {
			items: [
				{ name: 'A', lowStock: true },
				{ name: 'B', lowStock: false }
			]
		});
		expect(result.blocks).toEqual([{ type: 'list', items: [[{ type: 'text', value: 'A' }]] }]);
	});
});

describe('bind - formatters', () => {
	it('applies the default yen/number/date formatters to representative values', () => {
		expect(DEFAULT_FORMATTERS.yen(1234)).toBe(`¥${(1234).toLocaleString()}`);
		expect(DEFAULT_FORMATTERS.yen('n/a')).toBe('n/a');
		expect(DEFAULT_FORMATTERS.number(1234567)).toBe((1234567).toLocaleString());
		expect(DEFAULT_FORMATTERS.date(new Date(2026, 0, 15))).toBe('2026-01-15');
		expect(DEFAULT_FORMATTERS.date('2026-01-15')).toBe('2026-01-15');
		expect(DEFAULT_FORMATTERS.date('2026-01-15T09:30:00Z')).toBe('2026-01-15');
		expect(DEFAULT_FORMATTERS.date('not a date')).toBe('not a date');
	});

	it('registers and applies a custom formatter', () => {
		const result = bindTemplate(
			'{{ score | percent }}',
			{ score: 0.5 },
			{ percent: (v) => `${Number(v) * 100}%` }
		);
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: '50%' }] }
		]);
	});

	it('a custom formatter can override a default one', () => {
		const result = bindTemplate('{{ amount | yen }}', { amount: 100 }, { yen: (v) => `JPY${v}` });
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'JPY100' }] }
		]);
	});

	it('falls back to the raw value and warns on an unknown formatter', () => {
		const result = bindTemplate('{{ amount | bogus }}', { amount: 42 });
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: '42' }] }
		]);
		expect(result.warnings).toEqual(['unknown formatter: bogus']);
	});
});

describe('bind - parse errors become warnings', () => {
	it('surfaces an unclosed-block parse error as a warning', () => {
		const result = bindTemplate('{{#each items}}\n- {{ name }}', { items: [{ name: 'A' }] });
		expect(result.warnings).toContain('unclosed block: {{#each items}}');
	});
});
