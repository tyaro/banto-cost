/**
 * Issue #218: CSV 取込プレビューは先頭 N 行だけを描画し、新規/更新を区別し、
 * 送信ペイロードはプレビューと同じ検証済み行から作る。
 */
import { describe, expect, it } from 'vitest';
import {
	IMPORT_PREVIEW_ROW_LIMIT,
	importRowKind,
	previewRows,
	toImportPayload,
	type ImportRowPreview
} from './importPreview';

function makeRows(count: number): ImportRowPreview[] {
	return Array.from({ length: count }, (_, i) => ({
		csvLine: i + 2,
		// 偶数番目は id あり（更新）、奇数番目は id なし（新規）
		id: i % 2 === 0 ? 100 + i : undefined,
		name: `商品${i}`,
		price: 10 * i,
		stock: i,
		errors: []
	}));
}

describe('importRowKind', () => {
	it('id あり = 更新、なし = 新規', () => {
		expect(importRowKind({ id: 5 })).toBe('update');
		expect(importRowKind({ id: 0 })).toBe('update');
		expect(importRowKind({ id: undefined })).toBe('create');
	});
});

describe('previewRows', () => {
	it('上限を超える行は先頭 N 行だけを返す', () => {
		const rows = makeRows(IMPORT_PREVIEW_ROW_LIMIT + 25);
		const shown = previewRows(rows);
		expect(shown).toHaveLength(IMPORT_PREVIEW_ROW_LIMIT);
		expect(shown).toEqual(rows.slice(0, IMPORT_PREVIEW_ROW_LIMIT));
		expect(shown[0].csvLine).toBe(2);
	});

	it('上限以下なら全行を返す', () => {
		expect(previewRows(makeRows(3))).toHaveLength(3);
		expect(previewRows([])).toEqual([]);
	});

	it('limit を指定できる', () => {
		expect(previewRows(makeRows(8), 2)).toHaveLength(2);
	});

	it('表示行は新規/更新が混在しても区別できる', () => {
		const kinds = previewRows(makeRows(4)).map(importRowKind);
		expect(kinds).toEqual(['update', 'create', 'update', 'create']);
	});
});

describe('toImportPayload (プレビューと同じ行)', () => {
	it('プレビューに出る行は、送信ペイロードの先頭と同じ値になる', () => {
		const rows = makeRows(IMPORT_PREVIEW_ROW_LIMIT + 5);
		const payload = toImportPayload(rows);
		// 送信は全行（プレビューの表示行数に切り詰めない）
		expect(payload).toHaveLength(rows.length);
		previewRows(rows).forEach((row, i) => {
			expect(payload[i]).toEqual({
				id: row.id,
				name: row.name,
				price: row.price,
				stock: row.stock
			});
		});
	});

	it('値が未解決の行は既定値で埋める（エラー行は実行抑止で送られない前提）', () => {
		expect(toImportPayload([{ csvLine: 2, errors: [] }])).toEqual([
			{ id: undefined, name: '', price: 0, stock: 0 }
		]);
	});
});
