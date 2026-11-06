import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/core/errors';

describe('errorMessage', () => {
	it('extracts .message from a plain Error', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
	});

	it('extracts .message from a ProviderError-shaped object (duck-typed, no import)', () => {
		expect(errorMessage({ kind: 'not_found', message: 'デモモードでは利用できません' })).toBe(
			'デモモードでは利用できません'
		);
	});

	it('passes through a plain string', () => {
		expect(errorMessage('failure')).toBe('failure');
	});

	it('falls back to a generic message for unrecognized shapes', () => {
		expect(errorMessage(undefined)).toBe('不明なエラーが発生しました');
		expect(errorMessage(null)).toBe('不明なエラーが発生しました');
		expect(errorMessage(42)).toBe('不明なエラーが発生しました');
		expect(errorMessage({})).toBe('不明なエラーが発生しました');
	});
});
