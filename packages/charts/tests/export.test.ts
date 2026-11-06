import { describe, expect, it } from 'vitest';
import { inlineCssVarRefs } from '../src/core/export';

describe('inlineCssVarRefs', () => {
	it('replaces a single var() reference with the resolved value', () => {
		const result = inlineCssVarRefs('var(--banto-chart-1)', (name) =>
			name === '--banto-chart-1' ? '#2a78d6' : ''
		);
		expect(result).toBe('#2a78d6');
	});

	it('replaces multiple var() references in one string', () => {
		const result = inlineCssVarRefs('var(--a) var(--b)', (name) =>
			name === '--a' ? '1px' : '2px'
		);
		expect(result).toBe('1px 2px');
	});

	it('leaves non-var() content untouched around a resolved reference', () => {
		const result = inlineCssVarRefs('4 3', () => '');
		expect(result).toBe('4 3');
	});

	it('leaves an unresolvable reference as the original var(...) text (empty resolve)', () => {
		const result = inlineCssVarRefs('var(--unknown)', () => '');
		expect(result).toBe('var(--unknown)');
	});

	it('leaves an unresolvable reference as-is when resolve returns whitespace only', () => {
		const result = inlineCssVarRefs('var(--unknown)', () => '   ');
		expect(result).toBe('var(--unknown)');
	});

	it('trims the resolved value', () => {
		const result = inlineCssVarRefs('var(--x)', () => '  #ffffff  ');
		expect(result).toBe('#ffffff');
	});

	it('is a no-op on a string with no var() references', () => {
		const result = inlineCssVarRefs('#123456', () => 'ignored');
		expect(result).toBe('#123456');
	});
});
