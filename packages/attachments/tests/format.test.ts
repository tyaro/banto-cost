import { describe, expect, it } from 'vitest';
import { formatFileSize } from '../src/core/format';

describe('formatFileSize', () => {
	it('formats sub-1024 byte counts as whole bytes', () => {
		expect(formatFileSize(0)).toBe('0 B');
		expect(formatFileSize(1)).toBe('1 B');
		expect(formatFileSize(1023)).toBe('1023 B');
	});

	it('formats KB with one decimal place below 100', () => {
		expect(formatFileSize(1024)).toBe('1 KB');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(formatFileSize(10 * 1024 + 512)).toBe('10.5 KB');
	});

	it('drops the decimal once the value reaches 100 in its unit', () => {
		expect(formatFileSize(100 * 1024)).toBe('100 KB');
		expect(formatFileSize(102400 + 500)).toBe('100 KB');
	});

	it('formats MB (e.g. a 5MB photo attachment)', () => {
		expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
		expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
	});

	it('caps at the 25MB attachment limit (attachments-plan §7) without overflow oddities', () => {
		expect(formatFileSize(25 * 1024 * 1024)).toBe('25 MB');
	});

	it('falls back to "0 B" for non-finite or negative input rather than throwing', () => {
		expect(formatFileSize(Number.NaN)).toBe('0 B');
		expect(formatFileSize(-5)).toBe('0 B');
		expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('0 B');
	});
});
