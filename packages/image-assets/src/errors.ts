/**
 * Error codes of @banto/image-assets (ADR-0020 §3, shared-primitives-upstream-plan §3.7).
 *
 * The package holds no display text (conventions §13): a failure is an `ImageAssetError`
 * carrying a machine-readable `code` plus the values behind it (`detail`), and the app turns
 * the code into its own Paraglide message. `message` is the code itself and is not meant for
 * the screen.
 *
 * The codes for the import checks (PR-13) and the store (PR-14) are fixed here so both PRs
 * share one union; they may still be refined before the first release that ships the package.
 */

export const IMAGE_ASSET_ERROR_CODES = [
	/** The consumer passed limits that cannot be used (ADR-0020 §2). `detail.field` names it. */
	'invalid-limits',
	/** The bytes are not one of the allowed formats (or no known format at all). */
	'unsupported-format',
	/** The header claims a known format but is truncated or inconsistent. */
	'malformed-header',
	/** The byte length is over `maxBytes`. */
	'too-large',
	/** Width or height is over `maxEdge`. */
	'dimensions-too-large',
	/** `width * height` is over `maxPixels`. */
	'too-many-pixels',
	/** Reading the `Blob` / `File` failed (its data became unreadable, I/O error) (PR-13). */
	'read-failed',
	/** The browser could not decode the image (PR-13). */
	'decode-failed',
	/** The decoded size differs from what the header said (PR-13). */
	'dimensions-mismatch',
	/**
	 * Keeping the original would go over the store's total size (PR-14). `detail.limit` is
	 * `maxTotalBytes`, `detail.actual` the total it would have become.
	 */
	'store-full',
	/** The store holds no original with that hash (PR-14). `detail.hash` names it. */
	'unknown-asset',
	/** The store was disposed before the call (PR-14). */
	'store-disposed',
	/**
	 * `acquireUrl` was called for an original whose URL is still being created, from inside the
	 * injected `create` (PR-14). `detail.hash` names it.
	 */
	'url-pending'
] as const;

export type ImageAssetErrorCode = (typeof IMAGE_ASSET_ERROR_CODES)[number];

/** The values behind a failure, for the app to put into its own message. */
export interface ImageAssetErrorDetail {
	/** The limit that was crossed (bytes or pixels, depending on the code). */
	readonly limit?: number;
	/** The value that crossed it. */
	readonly actual?: number;
	/** For `invalid-limits`: the field of the limits object that was rejected. */
	readonly field?: string;
	/**
	 * The image size behind the failure: the header's size for `dimensions-too-large` and
	 * `too-many-pixels`, the decoded size for `dimensions-mismatch` (PR-13).
	 */
	readonly width?: number;
	readonly height?: number;
	/** For `unknown-asset` / `url-pending`: the hash that was asked for (PR-14). */
	readonly hash?: string;
}

export class ImageAssetError extends Error {
	readonly code: ImageAssetErrorCode;
	readonly detail: ImageAssetErrorDetail;

	constructor(code: ImageAssetErrorCode, detail: ImageAssetErrorDetail = {}) {
		super(code);
		this.name = 'ImageAssetError';
		this.code = code;
		this.detail = Object.freeze({ ...detail });
	}
}

/** Narrows an unknown thrown value (e.g. in a `catch`) to an `ImageAssetError`. */
export function isImageAssetError(value: unknown): value is ImageAssetError {
	return value instanceof ImageAssetError;
}
