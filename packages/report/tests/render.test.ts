import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/index';

describe('renderReport - daily report integration (plan §3.2 style)', () => {
	it('renders a full daily-report template to the expected HTML', () => {
		const template = [
			'# 日報',
			'',
			'**日付:** {{ date | date }}',
			'',
			'**総件数:** {{ totalCount | number }}',
			'',
			'**在庫合計金額:** {{ totalValue | yen }}',
			'',
			'## カテゴリ別集計',
			'',
			'| カテゴリ | 件数 |',
			'|---|---:|',
			'{{#each categories}}',
			'| {{ name }} | {{ count | number }} |',
			'{{/each}}',
			'',
			'{{#if lowStock}}',
			'## 在庫僅少',
			'',
			'| 商品名 | 在庫 |',
			'|---|---:|',
			'{{#each lowStock}}',
			'| {{ name }} | {{ stock | number }} |',
			'{{/each}}',
			'{{/if}}',
			'',
			'---',
			'',
			'## メモ',
			'',
			'- {{ note1 }}',
			'- {{ note2 }}'
		].join('\n');

		const data = {
			date: '2026-07-16',
			totalCount: 128,
			totalValue: 452000,
			categories: [
				{ name: '工具', count: 40 },
				{ name: '消耗品', count: 88 }
			],
			lowStock: [
				{ name: 'ねじ', stock: 3 },
				{ name: 'ボルト', stock: 12 }
			],
			note1: 'Note A',
			note2: 'Note B'
		};

		const result = renderReport(template, data);

		const expected =
			'<div class="report-body">' +
			'<h1>日報</h1>' +
			'<p><strong>日付:</strong> 2026-07-16</p>' +
			`<p><strong>総件数:</strong> ${(128).toLocaleString()}</p>` +
			`<p><strong>在庫合計金額:</strong> ¥${(452000).toLocaleString()}</p>` +
			'<h2>カテゴリ別集計</h2>' +
			'<table><thead><tr><th>カテゴリ</th><th class="report-align-right">件数</th></tr></thead>' +
			'<tbody>' +
			`<tr><td>工具</td><td class="report-align-right">${(40).toLocaleString()}</td></tr>` +
			`<tr><td>消耗品</td><td class="report-align-right">${(88).toLocaleString()}</td></tr>` +
			'</tbody></table>' +
			'<h2>在庫僅少</h2>' +
			'<table><thead><tr><th>商品名</th><th class="report-align-right">在庫</th></tr></thead>' +
			'<tbody>' +
			`<tr><td>ねじ</td><td class="report-align-right">${(3).toLocaleString()}</td></tr>` +
			`<tr><td>ボルト</td><td class="report-align-right">${(12).toLocaleString()}</td></tr>` +
			'</tbody></table>' +
			'<hr class="report-page-break">' +
			'<h2>メモ</h2>' +
			'<ul><li>Note A</li><li>Note B</li></ul>' +
			'</div>';

		expect(result.html).toBe(expected);
		expect(result.warnings).toEqual([]);
	});

	it('omits the low-stock section entirely when the array is empty (if + empty-array-falsy)', () => {
		const template = [
			'{{#if lowStock}}',
			'## 在庫僅少',
			'{{#each lowStock}}',
			'- {{ name }}',
			'{{/each}}',
			'{{/if}}',
			'',
			'## メモ'
		].join('\n');
		const result = renderReport(template, { lowStock: [] });
		expect(result.html).toBe('<div class="report-body"><h2>メモ</h2></div>');
	});
});

describe('renderReport - warnings', () => {
	it('collects unresolved-path, unknown-formatter and parse-error warnings from one render', () => {
		const template = '{{ missing }} {{ amount | bogus }}\n{{#each open}}\n- x\n';
		// `open` resolves to an empty (but present) array so it does not also
		// add its own "unresolved path" warning - this test is only about the
		// three warning *kinds* co-existing in one render, not the full count.
		const result = renderReport(template, { amount: 1, open: [] });
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				'unresolved path: missing',
				'unknown formatter: bogus',
				'unclosed block: {{#each open}}'
			])
		);
		expect(result.warnings).toHaveLength(3);
	});
});

describe('renderReport - XSS', () => {
	it('escapes a <script> payload in a data value so it cannot execute', () => {
		const result = renderReport('{{ payload }}', { payload: '<script>alert(1)</script>' });
		expect(result.html).toBe(
			'<div class="report-body"><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>'
		);
		expect(result.html).not.toContain('<script>');
	});

	it('escapes an attribute-breakout attempt in image alt/src data values', () => {
		const result = renderReport('![{{ altText }}]({{ imgSrc }})', {
			altText: '" onmouseover="alert(1)',
			imgSrc: 'photo.png" onerror="alert(1)'
		});
		expect(result.html).toBe(
			'<div class="report-body"><p><img src="photo.png&quot; onerror=&quot;alert(1)" alt="&quot; onmouseover=&quot;alert(1)"></p></div>'
		);
		// The dangerous form uses a literal, unescaped quote to break out of the
		// attribute; that literal quote must never survive rendering.
		expect(result.html).not.toContain('onmouseover="alert');
		expect(result.html).not.toContain('onerror="alert');
	});

	it('does not turn a raw <b> tag written in the template body into an HTML tag', () => {
		const result = renderReport('a <b>bold</b> tag', {});
		expect(result.html).toBe('<div class="report-body"><p>a &lt;b&gt;bold&lt;/b&gt; tag</p></div>');
	});

	it('neutralizes a javascript: image src and reports a warning', () => {
		const result = renderReport('![x]({{ src }})', { src: 'javascript:alert(document.cookie)' });
		expect(result.html).toBe('<div class="report-body"><p><img src="" alt="x"></p></div>');
		expect(result.warnings).toEqual([
			'unsafe image src blocked: javascript:alert(document.cookie)'
		]);
	});
});
