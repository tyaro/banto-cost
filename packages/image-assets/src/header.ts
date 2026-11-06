/**
 * Header check before decoding (ADR-0020, shared-primitives-upstream-plan §3.7, PR-13).
 *
 * Reads the format, width and height straight from the bytes and checks them against the
 * consumer's limits before the browser decodes (and allocates) the full image. The input is
 * untrusted: every read is bounds-checked, every loop advances by at least one byte, and a
 * broken or truncated file ends in an `ImageAssetError` (never a `RangeError` or a hang).
 *
 * This is a browser-side check for the import UI. It does not replace the server's check of
 * an upload (conventions §6: the server decides the MIME from the magic bytes itself).
 *
 * Scope (README "ヘッダ検査の範囲"):
 * - PNG: still images only. The first chunk must be a valid IHDR; every chunk length must fit;
 *   the file must end with IEND and nothing after it; an `acTL` chunk (APNG) is rejected as
 *   `unsupported-format`. CRCs are not checked (the decoder does).
 * - JPEG: the markers are walked up to the first frame header. Baseline (SOF0), extended
 *   sequential (SOF1) and progressive (SOF2) with 8-bit samples and 1, 3 or 4 components
 *   (grayscale, YCbCr / RGB, CMYK / YCCK) are accepted; lossless, hierarchical, arithmetic
 *   coded and 12-bit frames are `unsupported-format` (browsers do not decode them).
 * - The size is the stored size. EXIF orientation is not read: rotating by 90 degrees swaps
 *   width and height, which neither `maxEdge` nor `maxPixels` can tell apart, and the decode
 *   check (`verifyDecodedImage`) accepts the swapped size.
 */
import { ImageAssetError } from './errors';
import { validateImageImportLimits, type ImageFormat, type ImageImportLimits } from './limits';

/** What the header says, after it passed the limits. */
export interface ImageHeader {
	readonly format: ImageFormat;
	/** The MIME type from the content (not from the file name or `Blob.type`). */
	readonly mimeType: 'image/png' | 'image/jpeg';
	/** Stored width in pixels (before any EXIF orientation). */
	readonly width: number;
	/** Stored height in pixels (before any EXIF orientation). */
	readonly height: number;
	readonly byteLength: number;
	/**
	 * The image can be transparent: a PNG with an alpha channel (colour type 4 or 6) or a
	 * `tRNS` chunk. Always `false` for JPEG.
	 */
	readonly hasAlpha: boolean;
}

/** Bytes as the import check accepts them. */
export type ImageBytes = Uint8Array | ArrayBuffer;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Largest PNG width / height (PNG spec: at most 2^31 - 1). */
const PNG_MAX_DIMENSION = 0x7fffffff;

/** Allowed bit depths per PNG colour type (PNG spec 11.2.2). Indexed by colour type. */
const PNG_BIT_DEPTHS: readonly (readonly number[] | undefined)[] = [
	[1, 2, 4, 8, 16], // 0 grayscale
	undefined,
	[8, 16], // 2 truecolour
	[1, 2, 4, 8], // 3 indexed
	[8, 16], // 4 grayscale + alpha
	undefined,
	[8, 16] // 6 truecolour + alpha
];

/** Normalises the input to a `Uint8Array` view without copying. */
export function toBytes(input: ImageBytes): Uint8Array {
	if (input instanceof Uint8Array) return input;
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	throw new TypeError('image bytes must be a Uint8Array or an ArrayBuffer');
}

function malformed(): ImageAssetError {
	return new ImageAssetError('malformed-header');
}

function u16(bytes: Uint8Array, at: number): number {
	return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: Uint8Array, at: number): number {
	return ((bytes[at] << 24) >>> 0) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
}

function isPng(bytes: Uint8Array): boolean {
	if (bytes.length < PNG_SIGNATURE.length) return false;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
	return true;
}

function isJpeg(bytes: Uint8Array): boolean {
	return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** A chunk type is four ASCII letters (PNG spec 5.3). */
function isChunkType(bytes: Uint8Array, at: number): boolean {
	for (let i = at; i < at + 4; i++) {
		const c = bytes[i] | 0x20;
		if (c < 0x61 || c > 0x7a) return false;
	}
	return true;
}

function chunkTypeIs(bytes: Uint8Array, at: number, type: string): boolean {
	for (let i = 0; i < 4; i++) if (bytes[at + i] !== type.charCodeAt(i)) return false;
	return true;
}

type Size = { width: number; height: number; hasAlpha: boolean };

function readPng(bytes: Uint8Array, checkSize: (width: number, height: number) => void): Size {
	// Signature (8) + IHDR chunk (length 4, type 4, data 13, CRC 4).
	if (bytes.length < 33 || u32(bytes, 8) !== 13 || !chunkTypeIs(bytes, 12, 'IHDR'))
		throw malformed();
	const width = u32(bytes, 16);
	const height = u32(bytes, 20);
	const bitDepth = bytes[24];
	const colourType = bytes[25];
	if (width === 0 || height === 0 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION)
		throw malformed();
	const depths = colourType < PNG_BIT_DEPTHS.length ? PNG_BIT_DEPTHS[colourType] : undefined;
	if (depths === undefined || !depths.includes(bitDepth)) throw malformed();
	// Compression and filter method must be 0, interlace 0 (none) or 1 (Adam7).
	if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) throw malformed();
	checkSize(width, height);

	let hasAlpha = colourType === 4 || colourType === 6;
	let sawData = false;
	let offset = 33;
	// Each step moves at least 12 bytes forward, so the walk ends within bytes.length / 12 steps.
	while (offset + 12 <= bytes.length) {
		const length = u32(bytes, offset);
		const type = offset + 4;
		if (length > bytes.length - offset - 12 || !isChunkType(bytes, type)) throw malformed();
		if (chunkTypeIs(bytes, type, 'IHDR')) throw malformed();
		if (chunkTypeIs(bytes, type, 'acTL')) throw new ImageAssetError('unsupported-format');
		if (chunkTypeIs(bytes, type, 'tRNS')) hasAlpha = true;
		if (chunkTypeIs(bytes, type, 'IDAT')) sawData = true;
		offset += length + 12;
		if (chunkTypeIs(bytes, type, 'IEND')) {
			if (length !== 0 || !sawData || offset !== bytes.length) throw malformed();
			return { width, height, hasAlpha };
		}
	}
	throw malformed();
}

/** SOFn markers browsers decode: baseline, extended sequential, progressive (Huffman). */
const JPEG_SUPPORTED_SOF = [0xc0, 0xc1, 0xc2];
/** Other SOFn markers: lossless, hierarchical and arithmetic coded frames. */
const JPEG_UNSUPPORTED_SOF = [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

function readJpeg(bytes: Uint8Array, checkSize: (width: number, height: number) => void): Size {
	let offset = 2;
	// Each step consumes at least the marker byte, so the walk ends within bytes.length steps.
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) throw malformed();
		// Fill bytes (any number of 0xFF) may precede a marker (JPEG spec B.1.1.2).
		while (offset < bytes.length && bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) throw malformed();
		const marker = bytes[offset++];
		// Standalone markers without a length: TEM and RSTn.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		// A stuffed 0x00, a second SOI, EOI or the scan before any frame header.
		if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) throw malformed();
		if (offset + 2 > bytes.length) throw malformed();
		const length = u16(bytes, offset);
		if (length < 2 || length > bytes.length - offset) throw malformed();
		if (JPEG_UNSUPPORTED_SOF.includes(marker)) throw new ImageAssetError('unsupported-format');
		if (JPEG_SUPPORTED_SOF.includes(marker)) {
			if (length < 8) throw malformed();
			const precision = bytes[offset + 2];
			const height = u16(bytes, offset + 3);
			const width = u16(bytes, offset + 5);
			const components = bytes[offset + 7];
			if (length !== 8 + 3 * components) throw malformed();
			if (precision !== 8) throw new ImageAssetError('unsupported-format');
			if (components !== 1 && components !== 3 && components !== 4)
				throw new ImageAssetError('unsupported-format');
			// Height 0 defers the size to a DNL marker after the first scan; not read here.
			if (width === 0 || height === 0) throw malformed();
			checkSize(width, height);
			return { width, height, hasAlpha: false };
		}
		offset += length;
	}
	throw malformed();
}

/**
 * Checks the bytes of an image against the limits before decoding (ADR-0020 §2,
 * shared-primitives-upstream-plan §3.7). Order: byte length (`too-large`), format
 * (`unsupported-format` when the magic bytes are not an allowed format), header structure
 * (`malformed-header`), each edge (`dimensions-too-large`), pixel count (`too-many-pixels`).
 *
 * The limits are validated here as well (`invalid-limits`), so passing raw limits never
 * means an unchecked import. Throws `ImageAssetError`; returns the header when it passes.
 */
export function inspectImageHeader(input: ImageBytes, limits: ImageImportLimits): ImageHeader {
	const checked = validateImageImportLimits(limits);
	const bytes = toBytes(input);
	if (bytes.length > checked.maxBytes)
		throw new ImageAssetError('too-large', { limit: checked.maxBytes, actual: bytes.length });

	const format: ImageFormat | undefined = isPng(bytes) ? 'png' : isJpeg(bytes) ? 'jpeg' : undefined;
	if (format === undefined || !checked.formats.includes(format))
		throw new ImageAssetError('unsupported-format');

	const checkSize = (width: number, height: number) => {
		const edge = Math.max(width, height);
		if (edge > checked.maxEdge)
			throw new ImageAssetError('dimensions-too-large', {
				limit: checked.maxEdge,
				actual: edge,
				width,
				height
			});
		if (width * height > checked.maxPixels)
			throw new ImageAssetError('too-many-pixels', {
				limit: checked.maxPixels,
				actual: width * height,
				width,
				height
			});
	};
	const size = format === 'png' ? readPng(bytes, checkSize) : readJpeg(bytes, checkSize);
	return Object.freeze({
		format,
		mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
		width: size.width,
		height: size.height,
		byteLength: bytes.length,
		hasAlpha: size.hasAlpha
	});
}
