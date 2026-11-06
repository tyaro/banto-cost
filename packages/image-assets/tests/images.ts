// Tiny image byte strings built in the tests (no copyrighted images, no fixture files).
// The structure is what the header check reads: real PNG chunks with CRCs and real JPEG
// segments. The pixel data is not meant for a real decoder (decoding is injected in tests).

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
	const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
	const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
	let at = 0;
	for (const a of arrays) {
		out.set(a, at);
		at += a.length;
	}
	return out;
}

function be32(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function be16(n: number): number[] {
	return [(n >>> 8) & 0xff, n & 0xff];
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngChunk(type: string, data: number[] | Uint8Array = []): Uint8Array<ArrayBuffer> {
	const body = concat(
		[...type].map((c) => c.charCodeAt(0)),
		data
	);
	return concat(be32(body.length - 4), body, be32(crc32(body)));
}

export function ihdr(
	width: number,
	height: number,
	{ bitDepth = 8, colourType = 2, interlace = 0 } = {}
): Uint8Array<ArrayBuffer> {
	return pngChunk('IHDR', [...be32(width), ...be32(height), bitDepth, colourType, 0, 0, interlace]);
}

export interface PngOptions {
	colourType?: number;
	bitDepth?: number;
	/** Extra chunks between IHDR and IDAT. */
	before?: Uint8Array[];
}

export function png(
	width: number,
	height: number,
	options: PngOptions = {}
): Uint8Array<ArrayBuffer> {
	return concat(
		PNG_SIGNATURE,
		ihdr(width, height, options),
		...(options.before ?? []),
		pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
		pngChunk('IEND')
	);
}

export function segment(marker: number, data: number[]): number[] {
	return [0xff, marker, ...be16(data.length + 2), ...data];
}

export function sof(
	marker: number,
	width: number,
	height: number,
	{ components = 3, precision = 8 } = {}
): number[] {
	const comps: number[] = [];
	for (let i = 0; i < components; i++) comps.push(i + 1, 0x11, 0);
	return segment(marker, [precision, ...be16(height), ...be16(width), components, ...comps]);
}

const APP0_JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DQT = segment(0xdb, [0, ...new Array<number>(64).fill(1)]);
const DHT = segment(0xc4, [0, 0, 1, ...new Array<number>(15).fill(0), 0]);
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0]);

export interface JpegOptions {
	marker?: number;
	components?: number;
	precision?: number;
	/** Segments between APP0 and the frame header. */
	before?: number[][];
}

export function jpeg(
	width: number,
	height: number,
	options: JpegOptions = {}
): Uint8Array<ArrayBuffer> {
	return concat(
		[0xff, 0xd8],
		APP0_JFIF,
		...(options.before ?? []),
		DQT,
		sof(options.marker ?? 0xc0, width, height, options),
		DHT,
		SOS,
		[0x12, 0x34, 0xff, 0x00, 0x56],
		[0xff, 0xd9]
	);
}

/** An EXIF APP1 segment saying "rotate 90" (orientation 6), big-endian TIFF. */
export const EXIF_ROTATE_90 = segment(0xe1, [
	...[0x45, 0x78, 0x69, 0x66, 0, 0], // "Exif\0\0"
	...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8], // TIFF header, IFD at offset 8
	...[0, 1], // one entry
	...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0], // Orientation (SHORT) = 6
	...[0, 0, 0, 0] // no next IFD
]);
