import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse-parser';

describe('createSseParser', () => {
	it('parses a single event delivered in one chunk', () => {
		const parser = createSseParser();
		const events = parser.push('data: {"kind":"notice"}\n\n');
		expect(events).toEqual(['{"kind":"notice"}']);
	});

	it('parses an event split across multiple chunks', () => {
		const parser = createSseParser();
		expect(parser.push('data: {"kin')).toEqual([]);
		expect(parser.push('d":"notice"}')).toEqual([]);
		expect(parser.push('\n\n')).toEqual(['{"kind":"notice"}']);
	});

	it('splits the terminating blank line itself across chunks', () => {
		const parser = createSseParser();
		expect(parser.push('data: {"a":1}\n')).toEqual([]);
		expect(parser.push('\n')).toEqual(['{"a":1}']);
	});

	it('tolerates keep-alive comment lines (no event emitted)', () => {
		const parser = createSseParser();
		expect(parser.push(': keep-alive\n\n')).toEqual([]);
	});

	it('ignores comments interleaved between real events', () => {
		const parser = createSseParser();
		const events = parser.push('data: one\n\n: keep-alive\n\ndata: two\n\n');
		expect(events).toEqual(['one', 'two']);
	});

	it('parses multiple whole events delivered in a single chunk', () => {
		const parser = createSseParser();
		const events = parser.push('data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\n');
		expect(events).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
	});

	it('joins multiple data: lines within one event with a newline', () => {
		const parser = createSseParser();
		const events = parser.push('data: line1\ndata: line2\n\n');
		expect(events).toEqual(['line1\nline2']);
	});

	it('supports CRLF line endings', () => {
		const parser = createSseParser();
		const events = parser.push('data: hello\r\n\r\n');
		expect(events).toEqual(['hello']);
	});

	it('ignores non-data fields such as event:/id:/retry:', () => {
		const parser = createSseParser();
		const events = parser.push('event: banto\nid: 1\nretry: 1000\ndata: payload\n\n');
		expect(events).toEqual(['payload']);
	});

	it('returns an empty array while no event boundary has been reached', () => {
		const parser = createSseParser();
		expect(parser.push('data: incomplete')).toEqual([]);
	});
});
