/**
 * Limits for importing an image (ADR-0020 §2, shared-primitives-upstream-plan §3.7).
 *
 * The consumer always passes the limits: the package has no defaults (SCADA's 8 MiB / 8192 px
 * are not baked in) and "no limit" is not a default either, so forgetting a limit never means
 * an unlimited import. The limits are checked once with `validateImageImportLimits` before
 * they are used. The store's total size (PR-14) is a separate option of the store.
 */
import { ImageAssetError } from './errors';

/** Formats the import check can read from the header (PR-13). */
export const IMAGE_FORMATS = ['png', 'jpeg'] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export interface ImageImportLimits {
	/** Maximum byte length of the file. */
	readonly maxBytes: number;
	/** Maximum width and maximum height, in pixels (each edge on its own). */
	readonly maxEdge: number;
	/** Maximum `width * height`. */
	readonly maxPixels: number;
	/** Allowed formats; at least one. */
	readonly formats: readonly ImageFormat[];
}

const NUMERIC_FIELDS = ['maxBytes', 'maxEdge', 'maxPixels'] as const;

/**
 * Checks the consumer's limits and returns a frozen copy (formats de-duplicated, in the
 * given order). Throws `ImageAssetError('invalid-limits', { field })` when a number is not a
 * positive safe integer, or when `formats` is empty or names an unknown format.
 */
/** Every slot is a known format. Index each slot: `every` skips the holes of a sparse array. */
function allKnownFormats(formats: unknown[]): boolean {
	for (let i = 0; i < formats.length; i++) {
		if (!(i in formats) || !(IMAGE_FORMATS as readonly unknown[]).includes(formats[i]))
			return false;
	}
	return true;
}

export function validateImageImportLimits(limits: ImageImportLimits): ImageImportLimits {
	if (typeof limits !== 'object' || limits === null)
		throw new ImageAssetError('invalid-limits', { field: 'limits' });
	for (const field of NUMERIC_FIELDS) {
		const value: unknown = limits[field];
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
			throw new ImageAssetError('invalid-limits', { field });
	}
	const formats: unknown = limits.formats;
	if (!Array.isArray(formats) || formats.length === 0 || !allKnownFormats(formats))
		throw new ImageAssetError('invalid-limits', { field: 'formats' });
	return Object.freeze({
		maxBytes: limits.maxBytes,
		maxEdge: limits.maxEdge,
		maxPixels: limits.maxPixels,
		formats: Object.freeze([...new Set(formats as ImageFormat[])])
	});
}
