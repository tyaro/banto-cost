/**
 * Public types for `@banto/attachments` (spec `docs/design/attachments-plan.md`
 * §3.7). Deliberately duplicated from - not imported from -
 * `apps/admin-template/src/lib/banto/attachmentsAdmin.ts`: the package must
 * stay transport-agnostic and free of app-specific imports (spec: "アプリ固有
 * import（sessionStore 等）禁止"), so `AttachmentMeta`'s shape here is the
 * contract the app-side client adapter has to match, not a re-export of it.
 */

/** Mirrors `banto_attachments::AttachmentMeta` (camelCase on the wire, attachments-plan §3.2). */
export interface AttachmentMeta {
	id: number;
	resource: string;
	resourceId: string;
	fileName: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	hasThumbnail: boolean;
	createdAt: string;
	createdBy: string | null;
}

/**
 * Transport-agnostic adapter `AttachmentsPanel` receives via props (attachments-plan
 * §3.7). The app wires this up from `attachmentsAdmin.ts` (or an equivalent
 * REST/Tauri client); the package itself never imports that file.
 *
 * `thumbnailUrl`/`downloadUrl` return `Promise<string>` object URLs (not a
 * plain static URL) because every real transport must authenticate the byte
 * fetch itself (see `attachmentsAdmin.ts`'s module doc comment) - the panel
 * owns calling `URL.revokeObjectURL()` once an object URL is no longer
 * displayed/needed (attachments-plan §3.7: "呼び出し側が revoke を所有").
 */
export interface AttachmentsClient {
	list(resource: string, resourceId: string): Promise<AttachmentMeta[]>;
	upload(resource: string, resourceId: string, file: File): Promise<AttachmentMeta>;
	remove(id: number): Promise<void>;
	thumbnailUrl(meta: AttachmentMeta): Promise<string>;
	downloadUrl(meta: AttachmentMeta): Promise<string>;
}
