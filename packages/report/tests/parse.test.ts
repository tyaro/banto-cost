import { describe, expect, it } from 'vitest';
import { parse, parseInline } from '../src/core/parse';

describe('parse - blocks', () => {
	it('parses h1/h2/h3 headings', () => {
		const result = parse('# Title\n\n## Subtitle\n\n### Note');
		expect(result.blocks).toEqual([
			{ type: 'heading', level: 1, children: [{ type: 'text', value: 'Title' }] },
			{ type: 'heading', level: 2, children: [{ type: 'text', value: 'Subtitle' }] },
			{ type: 'heading', level: 3, children: [{ type: 'text', value: 'Note' }] }
		]);
		expect(result.errors).toEqual([]);
	});

	it('joins consecutive lines into one paragraph, separated by a blank line', () => {
		const result = parse('Line one\nLine two\n\nSecond paragraph');
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'Line one Line two' }] },
			{ type: 'paragraph', children: [{ type: 'text', value: 'Second paragraph' }] }
		]);
	});

	it('parses a bulleted list as consecutive `- ` lines', () => {
		const result = parse('- Apple\n- Banana\n- Cherry');
		expect(result.blocks).toEqual([
			{
				type: 'list',
				items: [
					[{ type: 'text', value: 'Apple' }],
					[{ type: 'text', value: 'Banana' }],
					[{ type: 'text', value: 'Cherry' }]
				]
			}
		]);
	});

	it('parses a horizontal rule as a page-break node', () => {
		const result = parse('Before\n\n---\n\nAfter');
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'Before' }] },
			{ type: 'pagebreak' },
			{ type: 'paragraph', children: [{ type: 'text', value: 'After' }] }
		]);
	});

	it('parses a table with left/right/center column alignment', () => {
		const result = parse('| Name | Qty | Note |\n|---|---:|:---:|\n| A | 1 | x |');
		expect(result.blocks).toEqual([
			{
				type: 'table',
				align: ['left', 'right', 'center'],
				header: [
					[{ type: 'text', value: 'Name' }],
					[{ type: 'text', value: 'Qty' }],
					[{ type: 'text', value: 'Note' }]
				],
				rows: [
					{
						kind: 'row',
						cells: [
							[{ type: 'text', value: 'A' }],
							[{ type: 'text', value: '1' }],
							[{ type: 'text', value: 'x' }]
						]
					}
				]
			}
		]);
	});

	it('treats a `|`-led line group without a valid separator as a plain paragraph', () => {
		const result = parse('| not | a table |\nstill text');
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: '| not | a table | still text' }] }
		]);
	});

	it('parses a mixed document (heading, paragraph, list, table, page break) in order', () => {
		const template = [
			'# Daily Report',
			'',
			'Summary text.',
			'',
			'- Item A',
			'- Item B',
			'',
			'| Name | Qty |',
			'|---|---:|',
			'| Widget | 3 |',
			'',
			'---',
			'',
			'## Page 2'
		].join('\n');
		const result = parse(template);
		expect(result.blocks.map((b) => b.type)).toEqual([
			'heading',
			'paragraph',
			'list',
			'table',
			'pagebreak',
			'heading'
		]);
		expect(result.errors).toEqual([]);
	});
});

describe('parse - inline', () => {
	it('parses bold and italic', () => {
		expect(parseInline('**bold** and *italic*')).toEqual([
			{ type: 'bold', children: [{ type: 'text', value: 'bold' }] },
			{ type: 'text', value: ' and ' },
			{ type: 'italic', children: [{ type: 'text', value: 'italic' }] }
		]);
	});

	it('parses an image with alt and src', () => {
		expect(parseInline('![A photo](photo.png)')).toEqual([
			{
				type: 'image',
				alt: [{ type: 'text', value: 'A photo' }],
				src: [{ type: 'text', value: 'photo.png' }]
			}
		]);
	});

	it('parses a placeholder with and without a formatter', () => {
		expect(parseInline('{{ total }} / {{ total | yen }}')).toEqual([
			{ type: 'placeholder', path: 'total', formatter: undefined },
			{ type: 'text', value: ' / ' },
			{ type: 'placeholder', path: 'total', formatter: 'yen' }
		]);
	});

	it('parses a placeholder inside image alt and src', () => {
		expect(parseInline('![{{ label }}]({{ photoUrl }})')).toEqual([
			{
				type: 'image',
				alt: [{ type: 'placeholder', path: 'label', formatter: undefined }],
				src: [{ type: 'placeholder', path: 'photoUrl', formatter: undefined }]
			}
		]);
	});

	it('parses a compound line: bold, placeholder and italic together', () => {
		expect(parseInline('**Total:** {{ total | yen }} (*tax included*)')).toEqual([
			{ type: 'bold', children: [{ type: 'text', value: 'Total:' }] },
			{ type: 'text', value: ' ' },
			{ type: 'placeholder', path: 'total', formatter: 'yen' },
			{ type: 'text', value: ' (' },
			{ type: 'italic', children: [{ type: 'text', value: 'tax included' }] },
			{ type: 'text', value: ')' }
		]);
	});

	it('does not recognize raw HTML as syntax - `<` is plain text', () => {
		expect(parseInline('a <b>bold</b> tag')).toEqual([
			{ type: 'text', value: 'a <b>bold</b> tag' }
		]);
	});

	it('splits table cells on `|` but not on the formatter pipe inside `{{ }}`', () => {
		const result = parse('| Name | Qty |\n|---|---:|\n| {{ name }} | {{ stock | number }} |');
		const table = result.blocks[0];
		expect(table).toMatchObject({ type: 'table' });
		if (table.type !== 'table') throw new Error('expected table');
		expect(table.rows).toEqual([
			{
				kind: 'row',
				cells: [
					[{ type: 'placeholder', path: 'name', formatter: undefined }],
					[{ type: 'placeholder', path: 'stock', formatter: 'number' }]
				]
			}
		]);
	});
});

describe('parse - each/if control blocks', () => {
	it('parses a block-level {{#each}} wrapping paragraphs', () => {
		const result = parse('{{#each items}}\n{{ name }}\n{{/each}}');
		expect(result.blocks).toEqual([
			{
				type: 'each',
				path: 'items',
				children: [
					{
						type: 'paragraph',
						children: [{ type: 'placeholder', path: 'name', formatter: undefined }]
					}
				]
			}
		]);
		expect(result.errors).toEqual([]);
	});

	it('parses a block-level {{#if}} wrapping a paragraph', () => {
		const result = parse('{{#if hasNotes}}\nSee notes.\n{{/if}}');
		expect(result.blocks).toEqual([
			{
				type: 'if',
				path: 'hasNotes',
				children: [{ type: 'paragraph', children: [{ type: 'text', value: 'See notes.' }] }]
			}
		]);
	});

	it('parses {{#each}} wrapping a run of table rows (row-repeat form)', () => {
		const template = [
			'| Name | Stock |',
			'|---|---:|',
			'{{#each lowStock}}',
			'| {{ name }} | {{ stock | number }} |',
			'{{/each}}'
		].join('\n');
		const result = parse(template);
		const table = result.blocks[0];
		if (table.type !== 'table') throw new Error('expected table');
		expect(table.rows).toEqual([
			{
				kind: 'each',
				path: 'lowStock',
				rows: [
					{
						kind: 'row',
						cells: [
							[{ type: 'placeholder', path: 'name', formatter: undefined }],
							[{ type: 'placeholder', path: 'stock', formatter: 'number' }]
						]
					}
				]
			}
		]);
		expect(result.errors).toEqual([]);
	});

	it('parses nested {{#each}} row groups inside a table', () => {
		const template = [
			'| Category | Item |',
			'|---|---|',
			'{{#each categories}}',
			'{{#each items}}',
			'| {{ category }} | {{ . }} |',
			'{{/each}}',
			'{{/each}}'
		].join('\n');
		const result = parse(template);
		const table = result.blocks[0];
		if (table.type !== 'table') throw new Error('expected table');
		expect(table.rows).toEqual([
			{
				kind: 'each',
				path: 'categories',
				rows: [
					{
						kind: 'each',
						path: 'items',
						rows: [
							{
								kind: 'row',
								cells: [
									[{ type: 'placeholder', path: 'category', formatter: undefined }],
									[{ type: 'placeholder', path: '.', formatter: undefined }]
								]
							}
						]
					}
				]
			}
		]);
	});

	it('parses nested block-level each inside each', () => {
		const result = parse(
			'{{#each departments}}\n## {{ name }}\n{{#each staff}}\n- {{ . }}\n{{/each}}\n{{/each}}'
		);
		expect(result.blocks).toEqual([
			{
				type: 'each',
				path: 'departments',
				children: [
					{
						type: 'heading',
						level: 2,
						children: [{ type: 'placeholder', path: 'name', formatter: undefined }]
					},
					{
						type: 'each',
						path: 'staff',
						children: [
							{ type: 'list', items: [[{ type: 'placeholder', path: '.', formatter: undefined }]] }
						]
					}
				]
			}
		]);
		expect(result.errors).toEqual([]);
	});
});

describe('parse - malformed control blocks', () => {
	it('records an error for an unclosed {{#each}} but still returns the partial AST', () => {
		const result = parse('{{#each items}}\n- {{ name }}');
		expect(result.errors).toEqual(['unclosed block: {{#each items}}']);
		expect(result.blocks).toEqual([
			{
				type: 'each',
				path: 'items',
				children: [
					{ type: 'list', items: [[{ type: 'placeholder', path: 'name', formatter: undefined }]] }
				]
			}
		]);
	});

	it('records an error for a mismatched closing tag', () => {
		const result = parse('{{#each items}}\n- {{ name }}\n{{/if}}');
		expect(result.errors).toEqual(['mismatched closing tag: expected {{/each}}, found {{/if}}']);
	});

	it('records an error for a stray closing tag with nothing open', () => {
		const result = parse('Some text\n{{/each}}\nMore text');
		expect(result.errors).toEqual(['unmatched closing tag: {{/each}}']);
		// The stray line is dropped; the surrounding paragraphs still parse.
		expect(result.blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'Some text' }] },
			{ type: 'paragraph', children: [{ type: 'text', value: 'More text' }] }
		]);
	});
});
