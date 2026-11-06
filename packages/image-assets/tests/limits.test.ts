import { describe, expect, it } from 'vitest';
import {
	IMAGE_ASSET_ERROR_CODES,
	ImageAssetError,
	isImageAssetError,
	validateImageImportLimits,
	type ImageImportLimits
} from '../src/index';

const limits: ImageImportLimits = {
	maxBytes: 8 * 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
};

function codeAndField(fn: () => unknown): [string, string | undefined] {
	try {
		fn();
	} catch (e) {
		if (isImageAssetError(e)) return [e.code, e.detail.field];
		throw e;
	}
	throw new Error('did not throw');
}

describe('validateImageImportLimits', () => {
	it('returns a frozen copy of valid limits', () => {
		const out = validateImageImportLimits(limits);
		expect(out).toEqual(limits);
		expect(out).not.toBe(limits);
		expect(Object.isFrozen(out)).toBe(true);
		expect(Object.isFrozen(out.formats)).toBe(true);
	});

	it('de-duplicates formats in the given order', () => {
		const out = validateImageImportLimits({ ...limits, formats: ['jpeg', 'png', 'jpeg'] });
		expect(out.formats).toEqual(['jpeg', 'png']);
	});

	it.each([
		['maxBytes', 0],
		['maxBytes', -1],
		['maxEdge', 1.5],
		['maxEdge', Number.POSITIVE_INFINITY],
		['maxPixels', Number.NaN],
		['maxPixels', '100']
	])('rejects %s = %s', (field, value) => {
		const bad = { ...limits, [field]: value } as unknown as ImageImportLimits;
		expect(codeAndField(() => validateImageImportLimits(bad))).toEqual(['invalid-limits', field]);
	});

	it('requires every numeric limit (no defaults)', () => {
		const { maxPixels: _omit, ...rest } = limits;
		const bad = rest as unknown as ImageImportLimits;
		expect(codeAndField(() => validateImageImportLimits(bad))).toEqual([
			'invalid-limits',
			'maxPixels'
		]);
	});

	it.each([[[]], [['gif']], ['png']])('rejects formats = %j', (formats) => {
		const bad = { ...limits, formats } as unknown as ImageImportLimits;
		expect(codeAndField(() => validateImageImportLimits(bad))).toEqual([
			'invalid-limits',
			'formats'
		]);
	});

	it('rejects a sparse formats array (a hole is not a known format)', () => {
		const sparse = new Array<string>(2);
		sparse[0] = 'png';
		const bad = { ...limits, formats: sparse } as unknown as ImageImportLimits;
		expect(codeAndField(() => validateImageImportLimits(bad))).toEqual([
			'invalid-limits',
			'formats'
		]);
	});

	it('rejects a non-object', () => {
		const bad = null as unknown as ImageImportLimits;
		expect(codeAndField(() => validateImageImportLimits(bad))).toEqual([
			'invalid-limits',
			'limits'
		]);
	});
});

describe('ImageAssetError', () => {
	it('carries the code as its message and a frozen detail', () => {
		const err = new ImageAssetError('too-large', { limit: 10, actual: 11 });
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('ImageAssetError');
		expect(err.message).toBe('too-large');
		expect(err.detail).toEqual({ limit: 10, actual: 11 });
		expect(Object.isFrozen(err.detail)).toBe(true);
	});

	it('isImageAssetError only accepts ImageAssetError', () => {
		expect(isImageAssetError(new ImageAssetError('store-full'))).toBe(true);
		expect(isImageAssetError(new Error('too-large'))).toBe(false);
		expect(isImageAssetError({ code: 'too-large' })).toBe(false);
	});

	it('error codes are unique kebab-case strings', () => {
		expect(new Set(IMAGE_ASSET_ERROR_CODES).size).toBe(IMAGE_ASSET_ERROR_CODES.length);
		for (const code of IMAGE_ASSET_ERROR_CODES) expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
	});
});
