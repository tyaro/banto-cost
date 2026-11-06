/**
 * Decode check and the combined import check (ADR-0020, shared-primitives-upstream-plan §3.7,
 * PR-13).
 *
 * The header check (`inspectImageHeader`) only reads what the file claims. Issue #438 asks to
 * confirm the real image after decoding as well, so `verifyDecodedImage` lets the browser
 * decode the bytes and compares the decoded size with the header. The decoder is injectable
 * (node / jsdom tests cannot decode); the default is `createImageBitmap`.
 */
import { ImageAssetError } from './errors';
import { inspectImageHeader, toBytes, type ImageBytes, type ImageHeader } from './header';
import { validateImageImportLimits, type ImageImportLimits } from './limits';
import { sha256Hex } from './sha256';

/** The decoded image as far as the check needs it. `close` is called when present. */
export interface DecodedImage {
	readonly width: number;
	readonly height: number;
	close?(): void;
}

/**
 * Decodes the image. Gets a `Blob` typed with the MIME type from the header (not the file's
 * own `type`). Rejecting or throwing means "could not decode".
 */
export type ImageDecoder = (blob: Blob) => Promise<DecodedImage>;

export interface DecodeOptions {
	/** Defaults to `createImageBitmap(blob, { imageOrientation: 'from-image' })`. */
	readonly decode?: ImageDecoder;
}

/** The decoded size; `transposed` when EXIF orientation swapped width and height. */
export interface DecodedSize {
	readonly width: number;
	readonly height: number;
	readonly transposed: boolean;
}

/**
 * Result of `inspectImage`: the header fields, with `width` / `height` replaced by the
 * decoded size (as the browser shows the image), plus `transposed` and the hash.
 */
export interface ImageMetadata extends ImageHeader {
	/** EXIF orientation swapped the stored width and height. */
	readonly transposed: boolean;
	/** SHA-256 of the original bytes, 64 lowercase hex digits (D11). */
	readonly sha256: string;
}

const decodeWithBrowser: ImageDecoder = async (blob) => {
	if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable');
	return createImageBitmap(blob, { imageOrientation: 'from-image' });
};

function blobOf(bytes: Uint8Array, mimeType: string): Blob {
	return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
}

/**
 * Decodes the bytes and checks the decoded size against the header (Issue #438: confirm the
 * real image after decoding). Throws `ImageAssetError('decode-failed')` when the decoder
 * fails or returns a size that is not a positive integer pair, and
 * `ImageAssetError('dimensions-mismatch', { width, height })` (the decoded size) when it
 * differs from the header. The swapped size counts as a match (EXIF orientation, which the
 * header check does not read). The decoded image is closed in every case.
 */
export async function verifyDecodedImage(
	input: ImageBytes,
	header: ImageHeader,
	options: DecodeOptions = {}
): Promise<DecodedSize> {
	const decode = options.decode ?? decodeWithBrowser;
	let decoded: DecodedImage;
	try {
		decoded = await decode(blobOf(toBytes(input), header.mimeType));
	} catch {
		throw new ImageAssetError('decode-failed');
	}
	try {
		const { width, height } = decoded;
		if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
			throw new ImageAssetError('decode-failed');
		if (width === header.width && height === header.height)
			return Object.freeze({ width, height, transposed: false });
		if (width === header.height && height === header.width)
			return Object.freeze({ width, height, transposed: true });
		throw new ImageAssetError('dimensions-mismatch', { width, height });
	} finally {
		try {
			decoded.close?.();
		} catch {
			// Closing is best effort; the result (or the error above) stands.
		}
	}
}

/**
 * The whole import check in order (shared-primitives-upstream-plan §3.7): byte length (from
 * `Blob.size` before reading a `Blob`), header (`inspectImageHeader`), decode
 * (`verifyDecodedImage`), then the hash (`sha256Hex`). Throws `ImageAssetError`.
 */
export async function inspectImage(
	input: Blob | ImageBytes,
	limits: ImageImportLimits,
	options: DecodeOptions = {}
): Promise<ImageMetadata> {
	const checked = validateImageImportLimits(limits);
	return inspectOwnedBytes(await readImageInput(input, checked), checked, options);
}

/**
 * Package-internal (the store, PR-14): the byte length check and the one copy of the input.
 * `limits` must already be validated. The returned bytes belong to the caller of this
 * function alone (never the caller's memory).
 */
export async function readImageInput(
	input: Blob | ImageBytes,
	limits: ImageImportLimits
): Promise<Uint8Array> {
	if (typeof Blob !== 'undefined' && input instanceof Blob) {
		// Refuse an oversized file before reading it into memory.
		if (input.size > limits.maxBytes)
			throw new ImageAssetError('too-large', { limit: limits.maxBytes, actual: input.size });
		try {
			return new Uint8Array(await input.arrayBuffer());
		} catch {
			throw new ImageAssetError('read-failed');
		}
	}
	const live = toBytes(input as ImageBytes);
	// Refuse before copying, then snapshot: the caller owns this memory and may reuse it
	// while decode is pending, so the header, the decoder and the hash must all see one copy.
	if (live.byteLength > limits.maxBytes)
		throw new ImageAssetError('too-large', { limit: limits.maxBytes, actual: live.byteLength });
	// `new Uint8Array(view)` always copies; a subclass's `slice` may not (Node's
	// `Buffer.slice` returns a view of the same memory).
	return new Uint8Array(live);
}

/**
 * Package-internal (the store, PR-14): header, decode and hash over bytes that nobody else
 * can change (from `readImageInput`). `limits` must already be validated.
 */
export async function inspectOwnedBytes(
	bytes: Uint8Array,
	checked: ImageImportLimits,
	options: DecodeOptions
): Promise<ImageMetadata> {
	const header = inspectImageHeader(bytes, checked);
	const decoded = await verifyDecodedImage(bytes, header, options);
	const sha256 = await sha256Hex(bytes);
	return Object.freeze({
		...header,
		width: decoded.width,
		height: decoded.height,
		transposed: decoded.transposed,
		sha256
	});
}
