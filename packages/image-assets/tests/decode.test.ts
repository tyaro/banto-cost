import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	inspectImage,
	inspectImageHeader,
	isImageAssetError,
	sha256Hex,
	verifyDecodedImage,
	type ImageDecoder,
	type ImageImportLimits
} from '../src/index';
import { jpeg, png } from './images';

const limits: ImageImportLimits = {
	maxBytes: 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
};

/** A decoder that answers with a fixed size and records what it got. */
function fakeDecoder(width: number, height: number) {
	const calls: Blob[] = [];
	const close = vi.fn();
	const decode: ImageDecoder = async (blob) => {
		calls.push(blob);
		return { width, height, close };
	};
	return { decode, calls, close };
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (e) {
		if (isImageAssetError(e)) return { code: e.code, detail: e.detail };
		throw e;
	}
	throw new Error('did not reject');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('verifyDecodedImage', () => {
	it('accepts the header size and hands the decoder a blob typed from the content', async () => {
		const bytes = png(3, 2);
		const header = inspectImageHeader(bytes, limits);
		const { decode, calls, close } = fakeDecoder(3, 2);
		await expect(verifyDecodedImage(bytes, header, { decode })).resolves.toEqual({
			width: 3,
			height: 2,
			transposed: false
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].type).toBe('image/png');
		expect(new Uint8Array(await calls[0].arrayBuffer())).toEqual(bytes);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('accepts the swapped size (EXIF orientation)', async () => {
		const bytes = jpeg(30, 10);
		const header = inspectImageHeader(bytes, limits);
		const { decode } = fakeDecoder(10, 30);
		await expect(verifyDecodedImage(bytes, header, { decode })).resolves.toEqual({
			width: 10,
			height: 30,
			transposed: true
		});
	});

	it('rejects a decoded size that differs from the header, and still closes it', async () => {
		const bytes = png(3, 2);
		const header = inspectImageHeader(bytes, limits);
		const { decode, close } = fakeDecoder(300, 200);
		expect(await rejection(verifyDecodedImage(bytes, header, { decode }))).toEqual({
			code: 'dimensions-mismatch',
			detail: { width: 300, height: 200 }
		});
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('turns a failing decoder into decode-failed', async () => {
		const bytes = png(1, 1);
		const header = inspectImageHeader(bytes, limits);
		const throwing: ImageDecoder = () => {
			throw new Error('boom');
		};
		const rejecting: ImageDecoder = () =>
			Promise.reject(new DOMException('bad', 'InvalidStateError'));
		expect((await rejection(verifyDecodedImage(bytes, header, { decode: throwing }))).code).toBe(
			'decode-failed'
		);
		expect((await rejection(verifyDecodedImage(bytes, header, { decode: rejecting }))).code).toBe(
			'decode-failed'
		);
	});

	it('rejects a nonsensical decoded size as decode-failed', async () => {
		const bytes = png(1, 1);
		const header = inspectImageHeader(bytes, limits);
		for (const [w, h] of [
			[0, 0],
			[Number.NaN, 1],
			[1.5, 1]
		]) {
			const { decode, close } = fakeDecoder(w, h);
			expect((await rejection(verifyDecodedImage(bytes, header, { decode }))).code).toBe(
				'decode-failed'
			);
			expect(close).toHaveBeenCalledTimes(1);
		}
	});

	it('keeps the result when close throws', async () => {
		const bytes = png(2, 2);
		const header = inspectImageHeader(bytes, limits);
		const decode: ImageDecoder = async () => ({
			width: 2,
			height: 2,
			close: () => {
				throw new Error('closed twice');
			}
		});
		await expect(verifyDecodedImage(bytes, header, { decode })).resolves.toMatchObject({
			width: 2
		});
	});

	it('uses createImageBitmap by default, and fails cleanly without it', async () => {
		const bytes = png(4, 3);
		const header = inspectImageHeader(bytes, limits);
		vi.stubGlobal('createImageBitmap', undefined);
		expect((await rejection(verifyDecodedImage(bytes, header))).code).toBe('decode-failed');

		const close = vi.fn();
		const createImageBitmap = vi.fn(async () => ({ width: 4, height: 3, close }));
		vi.stubGlobal('createImageBitmap', createImageBitmap);
		await expect(verifyDecodedImage(bytes, header)).resolves.toMatchObject({ width: 4, height: 3 });
		expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
			imageOrientation: 'from-image'
		});
		expect(close).toHaveBeenCalledTimes(1);
	});
});

describe('inspectImage', () => {
	it('runs header, decode and hash in order and returns the metadata', async () => {
		const bytes = jpeg(30, 10);
		const { decode } = fakeDecoder(10, 30);
		await expect(inspectImage(new Blob([bytes]), limits, { decode })).resolves.toEqual({
			format: 'jpeg',
			mimeType: 'image/jpeg',
			width: 10,
			height: 30,
			transposed: true,
			byteLength: bytes.length,
			hasAlpha: false,
			sha256: await sha256Hex(bytes)
		});
	});

	it('refuses an oversized Blob before reading it', async () => {
		const blob = new Blob([new Uint8Array(101)]);
		const read = vi.spyOn(blob, 'arrayBuffer');
		const { decode, calls } = fakeDecoder(1, 1);
		expect(await rejection(inspectImage(blob, { ...limits, maxBytes: 100 }, { decode }))).toEqual({
			code: 'too-large',
			detail: { limit: 100, actual: 101 }
		});
		expect(read).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it('does not decode when the header check fails', async () => {
		const { decode, calls } = fakeDecoder(9000, 1);
		expect((await rejection(inspectImage(png(9000, 1), limits, { decode }))).code).toBe(
			'dimensions-too-large'
		);
		expect(calls).toHaveLength(0);
	});

	it('accepts bytes as well as a Blob', async () => {
		const bytes = png(2, 1, { colourType: 6 });
		const { decode } = fakeDecoder(2, 1);
		await expect(inspectImage(bytes, limits, { decode })).resolves.toMatchObject({
			format: 'png',
			hasAlpha: true,
			transposed: false
		});
	});
});

describe('inspectImage review fixes (PR #452)', () => {
	it.each(['Uint8Array', 'ArrayBuffer'] as const)(
		'a %s mutated while decode is pending: header, decoder and hash all see one snapshot',
		async (kind) => {
			const original = png(2, 1);
			const expected = await sha256Hex(original);
			const view = original.slice();
			const input = kind === 'Uint8Array' ? view : view.buffer;
			let decodedHash = '';
			const decode: ImageDecoder = async (blob) => {
				view.fill(0); // the caller reuses its memory while decode is pending
				decodedHash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
				return { width: 2, height: 1 };
			};
			const result = await inspectImage(input, limits, { decode });
			expect(result).toMatchObject({ format: 'png', width: 2, height: 1 });
			expect(result.sha256).toBe(expected);
			expect(decodedHash).toBe(expected);
		}
	);

	it('a Uint8Array subclass whose slice shares memory (like Node Buffer) still gets copied', async () => {
		// Node's Buffer is a Uint8Array whose slice() returns a view, not a copy.
		class SharedSlice extends Uint8Array {
			override slice(start?: number, end?: number) {
				return this.subarray(start, end) as never;
			}
		}
		const original = png(2, 1);
		const expected = await sha256Hex(original);
		const input = new SharedSlice(original);
		let decodedHash = '';
		const decode: ImageDecoder = async (blob) => {
			input.fill(0);
			decodedHash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
			return { width: 2, height: 1 };
		};
		const result = await inspectImage(input, limits, { decode });
		expect(result.sha256).toBe(expected);
		expect(decodedHash).toBe(expected);
	});

	it('refuses oversized bytes before copying them', async () => {
		const { decode, calls } = fakeDecoder(1, 1);
		expect(
			await rejection(inspectImage(new Uint8Array(101), { ...limits, maxBytes: 100 }, { decode }))
		).toEqual({
			code: 'too-large',
			detail: { limit: 100, actual: 101 }
		});
		expect(calls).toHaveLength(0);
	});

	it('turns a Blob read failure into ImageAssetError read-failed', async () => {
		const blob = new Blob([png(2, 1)]);
		vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new DOMException('gone', 'NotReadableError'));
		const { decode, calls } = fakeDecoder(2, 1);
		expect((await rejection(inspectImage(blob, limits, { decode }))).code).toBe('read-failed');
		expect(calls).toHaveLength(0);
	});
});
