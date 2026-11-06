import { describe, expect, it, vi } from 'vitest';
import { createWedgeDetector, type WedgeKeyEvent } from '../src/core/detector';

/** Build a minimal `WedgeKeyEvent` for a printable/terminator key. */
function key(k: string, timeStamp: number, overrides: Partial<WedgeKeyEvent> = {}): WedgeKeyEvent {
	return { key: k, timeStamp, ...overrides };
}

describe('createWedgeDetector', () => {
	it('recognizes a fast burst + Enter as a single scan with the decoded string and info', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('C', 20))).toBe('buffered');
		expect(detector.handleKey(key('D', 30))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 35))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
	});

	it('does not fire when keys arrive 80ms apart (human typing speed)', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan });

		// Each key arrives >maxInterKeyMs (35) after the previous one, so the
		// buffer restarts at every keystroke and never reaches minLength.
		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 80))).toBe('buffered');
		expect(detector.handleKey(key('C', 160))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 240))).toBe('ignored');

		expect(onScan).not.toHaveBeenCalled();
	});

	it('discards a fast burst shorter than minLength on terminator', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 5))).toBe('buffered');
		expect(detector.handleKey(key('C', 10))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 15))).toBe('ignored');

		expect(onScan).not.toHaveBeenCalled();
	});

	it('discards the buffer when the terminator itself arrives after a long pause', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan });

		// A fast-typed fragment followed by a much-later, fully human Enter
		// (e.g. the user typed quickly, thought, then submitted a form) must
		// NOT count as a scan - listen.ts would otherwise swallow that
		// legitimate Enter via preventTerminatorDefault.
		detector.handleKey(key('A', 0));
		detector.handleKey(key('B', 10));
		detector.handleKey(key('C', 20));
		detector.handleKey(key('D', 30));
		expect(detector.handleKey(key('Enter', 2_000))).toBe('ignored');
		expect(onScan).not.toHaveBeenCalled();

		// The stale buffer was discarded, not left half-armed: a fresh burst
		// afterwards still scans normally.
		detector.handleKey(key('X', 3_000));
		detector.handleKey(key('Y', 3_010));
		detector.handleKey(key('Z', 3_020));
		detector.handleKey(key('W', 3_030));
		expect(detector.handleKey(key('Enter', 3_040))).toBe('scan');
		expect(onScan).toHaveBeenCalledWith('XYZW', { durationMs: 40, length: 4 });
	});

	it('resets on a slow gap mid-sequence and only scans the fast tail', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		// 'AB' typed fast, then a >35ms gap, then 'CDEF' typed fast.
		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('C', 110))).toBe('buffered'); // gap 100ms > 35ms -> restarts buffer at 'C'
		expect(detector.handleKey(key('D', 120))).toBe('buffered');
		expect(detector.handleKey(key('E', 130))).toBe('buffered');
		expect(detector.handleKey(key('F', 140))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 145))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('CDEF', { durationMs: 35, length: 4 });
	});

	it('is not broken by Shift keydowns interleaved for uppercase characters', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('Shift', 5))).toBe('ignored');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('Shift', 15))).toBe('ignored');
		expect(detector.handleKey(key('1', 20))).toBe('buffered');
		expect(detector.handleKey(key('Shift', 25))).toBe('ignored');
		expect(detector.handleKey(key('2', 30))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 35))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('AB12', { durationMs: 35, length: 4 });
	});

	it('ignores Ctrl/Alt/Meta key combos without disturbing an in-progress scan', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('x', 15, { ctrlKey: true }))).toBe('ignored');
		expect(detector.handleKey(key('Tab', 18, { altKey: true }))).toBe('ignored');
		expect(detector.handleKey(key('m', 22, { metaKey: true }))).toBe('ignored');
		expect(detector.handleKey(key('C', 30))).toBe('buffered');
		expect(detector.handleKey(key('D', 40))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 45))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 45, length: 4 });
	});

	it('ignores keys fired while composing (IME)', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('あ', 15, { isComposing: true }))).toBe('ignored');
		expect(detector.handleKey(key('C', 30))).toBe('buffered');
		expect(detector.handleKey(key('D', 40))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 45))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 45, length: 4 });
	});

	it('detects two consecutive scans independently', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('C', 20))).toBe('buffered');
		expect(detector.handleKey(key('D', 30))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 35))).toBe('scan');

		expect(detector.handleKey(key('W', 1000))).toBe('buffered');
		expect(detector.handleKey(key('X', 1010))).toBe('buffered');
		expect(detector.handleKey(key('Y', 1020))).toBe('buffered');
		expect(detector.handleKey(key('Z', 1030))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 1035))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(2);
		expect(onScan).toHaveBeenNthCalledWith(1, 'ABCD', { durationMs: 35, length: 4 });
		expect(onScan).toHaveBeenNthCalledWith(2, 'WXYZ', { durationMs: 35, length: 4 });
	});

	it('reset() discards the in-progress buffer without emitting a scan', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4 });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		expect(detector.handleKey(key('C', 20))).toBe('buffered');
		detector.reset();
		expect(detector.handleKey(key('Enter', 25))).toBe('ignored');
		expect(onScan).not.toHaveBeenCalled();

		// The detector keeps working normally after reset().
		expect(detector.handleKey(key('W', 100))).toBe('buffered');
		expect(detector.handleKey(key('X', 110))).toBe('buffered');
		expect(detector.handleKey(key('Y', 120))).toBe('buffered');
		expect(detector.handleKey(key('Z', 130))).toBe('buffered');
		expect(detector.handleKey(key('Enter', 135))).toBe('scan');
		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('WXYZ', { durationMs: 35, length: 4 });
	});

	it('supports a custom terminator list (e.g. Tab instead of Enter)', () => {
		const onScan = vi.fn();
		const detector = createWedgeDetector({ onScan, minLength: 4, terminators: ['Tab'] });

		expect(detector.handleKey(key('A', 0))).toBe('buffered');
		expect(detector.handleKey(key('B', 10))).toBe('buffered');
		// Enter is not a configured terminator here: it's a non-printable,
		// non-terminator key, so it's ignored without disturbing the buffer.
		expect(detector.handleKey(key('Enter', 15))).toBe('ignored');
		expect(detector.handleKey(key('C', 20))).toBe('buffered');
		expect(detector.handleKey(key('D', 30))).toBe('buffered');
		expect(detector.handleKey(key('Tab', 35))).toBe('scan');

		expect(onScan).toHaveBeenCalledTimes(1);
		expect(onScan).toHaveBeenCalledWith('ABCD', { durationMs: 35, length: 4 });
	});
});
