/**
 * CSV 取込プレビューの純粋ロジック（issue #218）。
 *
 * プレビュー表示と実際の送信は、`+page.svelte` の buildImportPreview が作った
 * **同じ検証済み行**（`ImportRowPreview[]`）から作る。プレビュー用に別の解析は
 * しない: 表に出す行は `previewRows`、送信ペイロードは `toImportPayload` が、
 * どちらも `rows` をそのまま入力にする。
 */
import type { ItemImportRow } from '#lib/banto/itemsAdmin.js';

/** 確認パネルに描画する先頭行数。大量データでも確認画面を重くしないための上限。 */
export const IMPORT_PREVIEW_ROW_LIMIT = 10;

export interface ImportRowPreview {
	/** 1-based CSV line number, header counted as line 1 (so the first data row is line 2). */
	csvLine: number;
	id?: number;
	name?: string;
	price?: number;
	stock?: number;
	errors: { columnId: string; message: string }[];
}

/** id あり = 既存レコードの更新、なし = 新規作成（spec M15）。 */
export function importRowKind(row: Pick<ImportRowPreview, 'id'>): 'create' | 'update' {
	return row.id === undefined ? 'create' : 'update';
}

/** 確認表に描画する先頭 `limit` 行。 */
export function previewRows(
	rows: ImportRowPreview[],
	limit: number = IMPORT_PREVIEW_ROW_LIMIT
): ImportRowPreview[] {
	return rows.slice(0, limit);
}

/** サーバーへ送る行。プレビューと同じ `rows` から作る。 */
export function toImportPayload(rows: ImportRowPreview[]): ItemImportRow[] {
	return rows.map((row) => ({
		id: row.id,
		name: row.name ?? '',
		price: row.price ?? 0,
		stock: row.stock ?? 0
	}));
}
