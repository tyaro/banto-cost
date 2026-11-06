import type { AttachmentMeta, AttachmentsClient } from '../types';
import { errorMessage } from './errors';

/**
 * Result of one `AttachmentsClient.list()` call, as a discriminated union
 * rather than a thrown exception - lets `AttachmentsPanel` (and this
 * module's own tests, see `tests/list.test.ts`) branch on
 * loading/一覧/空/エラー without needing a component render harness (the
 * states themselves follow attachments-plan §3.7; the logic is extracted
 * into plain functions because the workspace has no
 * `@testing-library/svelte`).
 */
export type ListOutcome =
	{ status: 'ok'; items: AttachmentMeta[] } | { status: 'error'; message: string };

/** Loads one record's attachments, converting a thrown error into `{status: 'error'}`. */
export async function fetchAttachmentList(
	client: Pick<AttachmentsClient, 'list'>,
	resource: string,
	resourceId: string
): Promise<ListOutcome> {
	try {
		const items = await client.list(resource, resourceId);
		return { status: 'ok', items };
	} catch (err) {
		return { status: 'error', message: errorMessage(err) };
	}
}

/** Splits a list into thumbnail-eligible (images) vs. plain file rows (attachments-plan §3.7). */
export function partitionByThumbnail(items: AttachmentMeta[]): {
	withThumbnail: AttachmentMeta[];
	withoutThumbnail: AttachmentMeta[];
} {
	const withThumbnail: AttachmentMeta[] = [];
	const withoutThumbnail: AttachmentMeta[] = [];
	for (const item of items) {
		(item.hasThumbnail ? withThumbnail : withoutThumbnail).push(item);
	}
	return { withThumbnail, withoutThumbnail };
}
