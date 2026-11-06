import { describe, expect, it } from 'vitest';
import type { ResolvedBlock } from '../src/core/bind';
import { renderHtml } from '../src/core/html';

describe('renderHtml - blocks', () => {
	it('wraps output in a `report-body` div', () => {
		const result = renderHtml([{ type: 'paragraph', children: [{ type: 'text', value: 'Hi' }] }]);
		expect(result.html).toBe('<div class="report-body"><p>Hi</p></div>');
	});

	it('renders h1/h2/h3', () => {
		const blocks: ResolvedBlock[] = [
			{ type: 'heading', level: 1, children: [{ type: 'text', value: 'A' }] },
			{ type: 'heading', level: 2, children: [{ type: 'text', value: 'B' }] },
			{ type: 'heading', level: 3, children: [{ type: 'text', value: 'C' }] }
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body"><h1>A</h1><h2>B</h2><h3>C</h3></div>'
		);
	});

	it('renders a list', () => {
		const blocks: ResolvedBlock[] = [
			{ type: 'list', items: [[{ type: 'text', value: 'A' }], [{ type: 'text', value: 'B' }]] }
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body"><ul><li>A</li><li>B</li></ul></div>'
		);
	});

	it('renders a page break as `<hr class="report-page-break">`', () => {
		expect(renderHtml([{ type: 'pagebreak' }]).html).toBe(
			'<div class="report-body"><hr class="report-page-break"></div>'
		);
	});

	it('renders a table with left (no class)/right/center alignment classes', () => {
		const blocks: ResolvedBlock[] = [
			{
				type: 'table',
				align: ['left', 'right', 'center'],
				header: [
					[{ type: 'text', value: 'A' }],
					[{ type: 'text', value: 'B' }],
					[{ type: 'text', value: 'C' }]
				],
				rows: [
					[
						[{ type: 'text', value: '1' }],
						[{ type: 'text', value: '2' }],
						[{ type: 'text', value: '3' }]
					]
				]
			}
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body">' +
				'<table><thead><tr><th>A</th><th class="report-align-right">B</th><th class="report-align-center">C</th></tr></thead>' +
				'<tbody><tr><td>1</td><td class="report-align-right">2</td><td class="report-align-center">3</td></tr></tbody></table>' +
				'</div>'
		);
	});
});

describe('renderHtml - inline', () => {
	it('renders bold and italic, including nested placehol<->text', () => {
		const blocks: ResolvedBlock[] = [
			{
				type: 'paragraph',
				children: [
					{ type: 'bold', children: [{ type: 'text', value: 'Total' }] },
					{ type: 'text', value: ': ' },
					{ type: 'italic', children: [{ type: 'text', value: 'tax incl.' }] }
				]
			}
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body"><p><strong>Total</strong>: <em>tax incl.</em></p></div>'
		);
	});

	it('renders an image with src/alt', () => {
		const blocks: ResolvedBlock[] = [
			{ type: 'paragraph', children: [{ type: 'image', src: 'photo.png', alt: 'A photo' }] }
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body"><p><img src="photo.png" alt="A photo"></p></div>'
		);
	});

	it('escapes & < > " \' in text nodes', () => {
		const blocks: ResolvedBlock[] = [
			{ type: 'paragraph', children: [{ type: 'text', value: `Tom & Jerry <script>"'` }] }
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body"><p>Tom &amp; Jerry &lt;script&gt;&quot;&#39;</p></div>'
		);
	});

	it('escapes quotes in image src/alt attributes', () => {
		const blocks: ResolvedBlock[] = [
			{
				type: 'paragraph',
				children: [{ type: 'image', src: 'x.png" onerror="alert(1)', alt: 'a "b"' }]
			}
		];
		expect(renderHtml(blocks).html).toBe(
			'<div class="report-body"><p><img src="x.png&quot; onerror=&quot;alert(1)" alt="a &quot;b&quot;"></p></div>'
		);
	});

	it('blocks a javascript: image src and reports a warning', () => {
		const blocks: ResolvedBlock[] = [
			{ type: 'paragraph', children: [{ type: 'image', src: 'javascript:alert(1)', alt: 'x' }] }
		];
		const result = renderHtml(blocks);
		expect(result.html).toBe('<div class="report-body"><p><img src="" alt="x"></p></div>');
		expect(result.warnings).toEqual(['unsafe image src blocked: javascript:alert(1)']);
	});

	it('blocks a javascript: src regardless of case/leading whitespace', () => {
		const blocks: ResolvedBlock[] = [
			{ type: 'paragraph', children: [{ type: 'image', src: '  JavaScript:alert(1)', alt: 'x' }] }
		];
		const result = renderHtml(blocks);
		expect(result.html).toContain('src=""');
		expect(result.warnings).toHaveLength(1);
	});
});
