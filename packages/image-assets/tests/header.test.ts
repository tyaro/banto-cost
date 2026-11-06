import { describe, expect, it } from 'vitest';
import {
	ImageAssetError,
	inspectImageHeader,
	isImageAssetError,
	type ImageAssetErrorDetail,
	type ImageImportLimits
} from '../src/index';
import {
	concat,
	EXIF_ROTATE_90,
	ihdr,
	jpeg,
	png,
	PNG_SIGNATURE,
	pngChunk,
	segment,
	sof
} from './images';

const limits: ImageImportLimits = {
	maxBytes: 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
};

function failure(bytes: Uint8Array | ArrayBuffer, l: ImageImportLimits = limits) {
	try {
		inspectImageHeader(bytes, l);
	} catch (e) {
		if (isImageAssetError(e)) return { code: e.code, detail: e.detail as ImageAssetErrorDetail };
		throw e;
	}
	throw new Error('did not throw');
}

const code = (bytes: Uint8Array, l: ImageImportLimits = limits) => failure(bytes, l).code;

describe('inspectImageHeader: PNG', () => {
	it('reads an opaque truecolour PNG', () => {
		const bytes = png(3, 2);
		expect(inspectImageHeader(bytes, limits)).toEqual({
			format: 'png',
			mimeType: 'image/png',
			width: 3,
			height: 2,
			byteLength: bytes.length,
			hasAlpha: false
		});
	});

	it('marks transparency: RGBA, grayscale + alpha, tRNS', () => {
		expect(inspectImageHeader(png(1, 1, { colourType: 6 }), limits).hasAlpha).toBe(true);
		expect(inspectImageHeader(png(1, 1, { colourType: 4 }), limits).hasAlpha).toBe(true);
		const palette = png(1, 1, {
			colourType: 3,
			before: [pngChunk('PLTE', [0, 0, 0]), pngChunk('tRNS', [0])]
		});
		expect(inspectImageHeader(palette, limits).hasAlpha).toBe(true);
	});

	it('accepts an ArrayBuffer, a sub-view and an interlaced PNG', () => {
		const bytes = png(5, 4);
		expect(inspectImageHeader(bytes.slice().buffer, limits).width).toBe(5);
		const padded = concat([9, 9, 9], bytes, [9]);
		expect(inspectImageHeader(padded.subarray(3, 3 + bytes.length), limits).height).toBe(4);
		const interlaced = concat(PNG_SIGNATURE, ihdr(2, 2, { interlace: 1 }), png(2, 2).subarray(33));
		expect(inspectImageHeader(interlaced, limits).width).toBe(2);
	});

	it('rejects APNG (acTL) as an unsupported format', () => {
		const apng = png(1, 1, { before: [pngChunk('acTL', [0, 0, 0, 1, 0, 0, 0, 0])] });
		expect(code(apng)).toBe('unsupported-format');
	});

	it('rejects a broken IHDR', () => {
		const tail = png(1, 1).subarray(33);
		const withIhdr = (chunk: Uint8Array) => concat(PNG_SIGNATURE, chunk, tail);
		expect(code(withIhdr(ihdr(0, 1)))).toBe('malformed-header');
		expect(code(withIhdr(ihdr(1, 0x80000000)))).toBe('malformed-header');
		expect(code(withIhdr(ihdr(1, 1, { colourType: 5 })))).toBe('malformed-header');
		expect(code(withIhdr(ihdr(1, 1, { colourType: 2, bitDepth: 4 })))).toBe('malformed-header');
		expect(code(withIhdr(ihdr(1, 1, { interlace: 2 })))).toBe('malformed-header');
		expect(code(withIhdr(pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0])))).toBe(
			'malformed-header'
		);
		// The first chunk is not IHDR.
		expect(code(concat(PNG_SIGNATURE, pngChunk('IDAT', new Array(13).fill(0)), tail))).toBe(
			'malformed-header'
		);
	});

	it('rejects broken chunk structure', () => {
		const head = concat(PNG_SIGNATURE, ihdr(1, 1));
		const idat = pngChunk('IDAT', [1, 2, 3]);
		const iend = pngChunk('IEND');
		// Data after IEND, no IDAT, a second IHDR, a non-letter chunk type, IEND with data.
		expect(code(concat(png(1, 1), [0]))).toBe('malformed-header');
		expect(code(concat(head, iend))).toBe('malformed-header');
		expect(code(concat(head, ihdr(1, 1), idat, iend))).toBe('malformed-header');
		expect(code(concat(head, pngChunk('ID1T', [0]), idat, iend))).toBe('malformed-header');
		expect(code(concat(head, idat, pngChunk('IEND', [0])))).toBe('malformed-header');
		// A chunk length past the end (also the 0xFFFFFFFF overflow).
		expect(code(concat(head, [0xff, 0xff, 0xff, 0xff], [0x49, 0x44, 0x41, 0x54], iend))).toBe(
			'malformed-header'
		);
		expect(code(concat(head, [0, 0, 0, 100], [0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0]))).toBe(
			'malformed-header'
		);
	});
});

describe('inspectImageHeader: JPEG', () => {
	it('reads a baseline JPEG', () => {
		const bytes = jpeg(640, 480);
		expect(inspectImageHeader(bytes, limits)).toEqual({
			format: 'jpeg',
			mimeType: 'image/jpeg',
			width: 640,
			height: 480,
			byteLength: bytes.length,
			hasAlpha: false
		});
	});

	it('reads progressive, extended sequential, grayscale and CMYK frames', () => {
		expect(inspectImageHeader(jpeg(10, 20, { marker: 0xc2 }), limits).width).toBe(10);
		expect(inspectImageHeader(jpeg(10, 20, { marker: 0xc1 }), limits).height).toBe(20);
		expect(inspectImageHeader(jpeg(7, 7, { components: 1 }), limits).width).toBe(7);
		expect(inspectImageHeader(jpeg(7, 8, { components: 4 }), limits).height).toBe(8);
	});

	it('reports the stored size even with an EXIF orientation', () => {
		const header = inspectImageHeader(jpeg(30, 10, { before: [EXIF_ROTATE_90] }), limits);
		expect([header.width, header.height]).toEqual([30, 10]);
	});

	it('skips fill bytes and standalone markers before the frame header', () => {
		const bytes = concat(
			[0xff, 0xd8, 0xff, 0xff, 0xff],
			segment(0xfe, [1]).slice(1),
			[0xff, 0x01],
			[0xff, 0xd0],
			sof(0xc0, 4, 3)
		);
		expect(inspectImageHeader(bytes, limits).width).toBe(4);
	});

	it('reads the 16-bit maximum size when the limits allow it', () => {
		const big = { ...limits, maxEdge: 65535, maxPixels: 65535 * 65535 };
		const header = inspectImageHeader(jpeg(65535, 65535), big);
		expect([header.width, header.height]).toEqual([65535, 65535]);
	});

	it('rejects frames browsers do not decode as unsupported', () => {
		for (const marker of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
			expect(code(jpeg(4, 4, { marker })), marker.toString(16)).toBe('unsupported-format');
		expect(code(jpeg(4, 4, { precision: 12 }))).toBe('unsupported-format');
		expect(code(jpeg(4, 4, { components: 2 }))).toBe('unsupported-format');
	});

	it('rejects bad segment lengths without looping or reading past the end', () => {
		const soi = [0xff, 0xd8];
		// Length 0 and 1 (would not advance), past the end, cut inside the length field.
		expect(code(concat(soi, [0xff, 0xe0, 0x00, 0x00]))).toBe('malformed-header');
		expect(code(concat(soi, [0xff, 0xe0, 0x00, 0x01], sof(0xc0, 1, 1)))).toBe('malformed-header');
		expect(code(concat(soi, [0xff, 0xe0, 0xff, 0xff, 0, 0]))).toBe('malformed-header');
		expect(code(concat(soi, [0xff, 0xe0, 0x00]))).toBe('malformed-header');
		// A frame header shorter than 8, or whose length disagrees with its component count.
		expect(code(concat(soi, segment(0xc0, [8, 0, 1, 0, 1])))).toBe('malformed-header');
		expect(code(concat(soi, segment(0xc0, [8, 0, 1, 0, 1, 3, 1, 0x11, 0])))).toBe(
			'malformed-header'
		);
		// Only fill bytes up to the end.
		expect(code(concat(soi, new Array(1000).fill(0xff)))).toBe('malformed-header');
	});

	it('rejects a broken marker sequence', () => {
		const soi = [0xff, 0xd8];
		// No 0xFF where the next marker should start (right after SOI it is not a JPEG at all).
		expect(code(concat(soi, [0x00, 0xe0, 0, 2], sof(0xc0, 1, 1)))).toBe('unsupported-format');
		expect(code(concat(soi, segment(0xe0, [1]), [0x00, 0xe0, 0, 2], sof(0xc0, 1, 1)))).toBe(
			'malformed-header'
		);
		expect(code(concat(soi, [0xff, 0xd9]))).toBe('malformed-header');
		expect(code(concat(soi, segment(0xda, [0]), sof(0xc0, 1, 1)))).toBe('malformed-header');
		expect(code(concat(soi, [0xff, 0xd8], sof(0xc0, 1, 1)))).toBe('malformed-header');
		expect(code(concat(soi, [0xff, 0x00], sof(0xc0, 1, 1)))).toBe('malformed-header');
		// Height 0 (the size comes later in a DNL marker) and width 0.
		expect(code(jpeg(4, 0))).toBe('malformed-header');
		expect(code(jpeg(0, 4))).toBe('malformed-header');
		// No frame header at all.
		expect(code(concat(soi, segment(0xe0, [1, 2])))).toBe('malformed-header');
	});
});

describe('inspectImageHeader: limits and formats', () => {
	it('rejects unknown and disallowed formats', () => {
		const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
		expect(code(gif)).toBe('unsupported-format');
		expect(code(new Uint8Array(0))).toBe('unsupported-format');
		expect(code(png(1, 1), { ...limits, formats: ['jpeg'] })).toBe('unsupported-format');
		expect(code(jpeg(1, 1), { ...limits, formats: ['png'] })).toBe('unsupported-format');
	});

	it('checks the byte length first', () => {
		const gif = new Uint8Array(101);
		expect(failure(gif, { ...limits, maxBytes: 100 })).toEqual({
			code: 'too-large',
			detail: { limit: 100, actual: 101 }
		});
		const bytes = png(1, 1);
		expect(() => inspectImageHeader(bytes, { ...limits, maxBytes: bytes.length })).not.toThrow();
	});

	it('rejects an edge over maxEdge with the size in the detail', () => {
		expect(failure(png(8193, 1))).toEqual({
			code: 'dimensions-too-large',
			detail: { limit: 8192, actual: 8193, width: 8193, height: 1 }
		});
		expect(failure(jpeg(10, 9000)).detail).toEqual({
			limit: 8192,
			actual: 9000,
			width: 10,
			height: 9000
		});
		expect(() => inspectImageHeader(png(8192, 1), limits)).not.toThrow();
	});

	it('rejects too many pixels, also for a huge PNG header on a tiny file', () => {
		expect(failure(png(5000, 4000))).toEqual({
			code: 'too-many-pixels',
			detail: { limit: 16_000_000, actual: 20_000_000, width: 5000, height: 4000 }
		});
		expect(() => inspectImageHeader(png(4000, 4000), limits)).not.toThrow();
		const wide = { ...limits, maxEdge: 0x7fffffff };
		expect(code(png(0x7fffffff, 0x7fffffff), wide)).toBe('too-many-pixels');
	});

	it('validates the limits it is given', () => {
		expect(failure(png(1, 1), { ...limits, maxEdge: 0 })).toEqual({
			code: 'invalid-limits',
			detail: { field: 'maxEdge' }
		});
	});

	it('rejects a non-byte input with a TypeError', () => {
		expect(() => inspectImageHeader('png' as unknown as Uint8Array, limits)).toThrow(TypeError);
	});
});

describe('inspectImageHeader: hostile input', () => {
	const samples = [
		png(3, 2),
		png(2, 2, { colourType: 3, before: [pngChunk('PLTE', [0, 0, 0]), pngChunk('tRNS', [0])] }),
		jpeg(16, 9),
		jpeg(16, 9, { marker: 0xc2, before: [EXIF_ROTATE_90] })
	];

	it('rejects every truncation with an ImageAssetError', () => {
		for (const sample of samples) {
			const full = inspectImageHeader(sample, limits);
			for (let n = 0; n < sample.length; n++) {
				let result: unknown;
				try {
					result = inspectImageHeader(sample.subarray(0, n), limits);
				} catch (e) {
					expect(e, `${full.format} cut at ${n}`).toBeInstanceOf(ImageAssetError);
					continue;
				}
				// A JPEG cut after its frame header still has a readable size (decode catches it).
				expect(full.format, `${full.format} cut at ${n}`).toBe('jpeg');
				expect(result).toMatchObject({ width: full.width, height: full.height });
			}
		}
	});

	it('never throws anything but ImageAssetError on random corruption', () => {
		let seed = 0x2545f491;
		const random = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 0x100000000;
		};
		for (let round = 0; round < 4000; round++) {
			const bytes = samples[round % samples.length].slice();
			const flips = 1 + Math.floor(random() * 4);
			for (let i = 0; i < flips; i++)
				bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
			try {
				const header = inspectImageHeader(bytes, limits);
				expect(header.width).toBeGreaterThan(0);
				expect(header.width).toBeLessThanOrEqual(limits.maxEdge);
				expect(header.width * header.height).toBeLessThanOrEqual(limits.maxPixels);
			} catch (e) {
				expect(e).toBeInstanceOf(ImageAssetError);
			}
		}
	});
});
