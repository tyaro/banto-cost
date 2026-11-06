import { describe, expect, it } from 'vitest';
import { fetchAttachmentList, partitionByThumbnail } from '../src/core/list';
import type { AttachmentMeta } from '../src/types';

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
	return {
		id: 1,
		resource: 'items',
		resourceId: '42',
		fileName: 'photo.jpg',
		mime: 'image/jpeg',
		sizeBytes: 1024,
		sha256: 'abc',
		hasThumbnail: true,
		createdAt: '2026-07-15T00:00:00Z',
		createdBy: 'admin',
		...overrides
	};
}

describe('fetchAttachmentList', () => {
	it('returns status "ok" with the resolved list (covers the populated-list branch)', async () => {
		const items = [meta({ id: 1 }), meta({ id: 2, hasThumbnail: false, fileName: 'notes.txt' })];
		const outcome = await fetchAttachmentList({ list: async () => items }, 'items', '42');
		expect(outcome).toEqual({ status: 'ok', items });
	});

	it('returns status "ok" with an empty array (covers the empty-state branch)', async () => {
		const outcome = await fetchAttachmentList({ list: async () => [] }, 'items', '42');
		expect(outcome).toEqual({ status: 'ok', items: [] });
	});

	it('converts a thrown error into status "error" with a display message (covers the error branch)', async () => {
		const outcome = await fetchAttachmentList(
			{
				list: async () => {
					throw new Error('サーバーに接続できません');
				}
			},
			'items',
			'42'
		);
		expect(outcome).toEqual({ status: 'error', message: 'サーバーに接続できません' });
	});

	it('passes resource/resourceId through to the client unchanged', async () => {
		let received: [string, string] | null = null;
		await fetchAttachmentList(
			{
				list: async (resource, resourceId) => {
					received = [resource, resourceId];
					return [];
				}
			},
			'items',
			'42'
		);
		expect(received).toEqual(['items', '42']);
	});
});

describe('partitionByThumbnail', () => {
	it('splits image (hasThumbnail) items from file-row items, preserving order within each group', () => {
		const a = meta({ id: 1, hasThumbnail: true });
		const b = meta({ id: 2, hasThumbnail: false });
		const c = meta({ id: 3, hasThumbnail: true });
		const { withThumbnail, withoutThumbnail } = partitionByThumbnail([a, b, c]);
		expect(withThumbnail).toEqual([a, c]);
		expect(withoutThumbnail).toEqual([b]);
	});

	it('returns empty arrays for an empty list', () => {
		expect(partitionByThumbnail([])).toEqual({ withThumbnail: [], withoutThumbnail: [] });
	});
});
