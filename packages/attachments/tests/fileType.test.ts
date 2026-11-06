import { describe, expect, it } from 'vitest';
import { fileTypeLabel } from '../src/core/fileType';

describe('fileTypeLabel', () => {
	it('uppercases a simple extension', () => {
		expect(fileTypeLabel('photo.jpg')).toBe('JPG');
		expect(fileTypeLabel('manual.pdf')).toBe('PDF');
	});

	it('uses the last extension for a multi-dot file name', () => {
		expect(fileTypeLabel('archive.tar.gz')).toBe('GZ');
	});

	it('truncates extensions longer than 4 characters', () => {
		expect(fileTypeLabel('data.jpeg2000')).toBe('JPEG');
	});

	it('falls back to FILE for a dotfile with no name before the dot', () => {
		expect(fileTypeLabel('.gitignore')).toBe('FILE');
	});

	it('falls back to FILE for a trailing dot with nothing after it', () => {
		expect(fileTypeLabel('readme.')).toBe('FILE');
	});

	it('falls back to FILE when there is no extension at all', () => {
		expect(fileTypeLabel('README')).toBe('FILE');
	});
});
