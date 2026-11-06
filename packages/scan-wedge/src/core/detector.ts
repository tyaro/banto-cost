// Headless core for M21 barcode/QR keyboard-wedge detection (docs/roadmap.md).
// DOM-free and fully unit-testable: no `Date.now()`/timers inside, timing is
// driven entirely by the `timeStamp` field of the events handed to
// `handleKey`. This lets tests script exact inter-key gaps deterministically.
//
// A wedge scanner types the decoded barcode/QR content as a very fast key
// sequence (typically 1-20ms between keys) followed by a terminator key
// (usually Enter). A human typing the same characters is virtually always
// slower (>80ms between keys). We tell the two apart with `maxInterKeyMs`.

export interface WedgeOptions {
	/** Called once per detected scan, with the decoded code and scan metadata. */
	onScan: (code: string, info: ScanInfo) => void;
	/** Minimum number of characters required before a terminator counts as a scan. Default 4. */
	minLength?: number;
	/**
	 * Maximum allowed gap (ms) between consecutive printable keys for them to
	 * belong to the same scan. Default 35 (human typing is usually >80ms;
	 * scanners are typically 1-20ms). A gap larger than this resets the
	 * buffer to the newly pressed character (see module docs).
	 */
	maxInterKeyMs?: number;
	/**
	 * Keys (as `KeyboardEvent.key`) that terminate a scan. Default `['Enter']`.
	 * Add `'Tab'` if the scanner is configured to send Tab. An empty array
	 * (terminator-less mode) is not supported in v1.
	 */
	terminators?: string[];
}

/** Metadata about a detected scan, passed alongside the decoded code to `onScan`. */
export interface ScanInfo {
	/** Elapsed ms from the first buffered character to the terminator key. */
	durationMs: number;
	/** Number of characters in the decoded code. */
	length: number;
}

/**
 * The subset of `KeyboardEvent` the core needs. Deliberately narrow (rather
 * than importing the DOM `KeyboardEvent` type) so the core has zero DOM
 * dependency and stays usable outside a browser (tests, Node). A real
 * `KeyboardEvent` satisfies this interface structurally.
 */
export interface WedgeKeyEvent {
	key: string;
	timeStamp: number;
	isComposing?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
}

export interface WedgeDetector {
	/**
	 * Feed one keydown event to the detector.
	 * - `'buffered'`: a printable character was added to the in-progress scan.
	 * - `'scan'`: a terminator arrived and the buffer met `minLength` -
	 *   `onScan` was called.
	 * - `'ignored'`: the event didn't affect (or didn't extend) the scan
	 *   buffer - a modifier combo, IME composition, a non-printable key other
	 *   than a terminator, or a terminator that arrived too early.
	 */
	handleKey(event: WedgeKeyEvent): 'buffered' | 'scan' | 'ignored';
	/** Discard any in-progress buffer without emitting a scan. */
	reset(): void;
}

const DEFAULT_MIN_LENGTH = 4;
const DEFAULT_MAX_INTER_KEY_MS = 35;
const DEFAULT_TERMINATORS = ['Enter'];

export function createWedgeDetector(options: WedgeOptions): WedgeDetector {
	const { onScan } = options;
	const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
	const maxInterKeyMs = options.maxInterKeyMs ?? DEFAULT_MAX_INTER_KEY_MS;
	const terminators = options.terminators ?? DEFAULT_TERMINATORS;

	// Buffer state, held in closure per spec (no module-level state - each
	// createWedgeDetector() call is independent).
	let buffer: string[] = [];
	let startTimestamp = 0;
	let lastTimestamp = 0;

	function clearBuffer(): void {
		buffer = [];
		startTimestamp = 0;
		lastTimestamp = 0;
	}

	function handleKey(event: WedgeKeyEvent): 'buffered' | 'scan' | 'ignored' {
		// Modifier combos (Ctrl/Alt/Meta) are never part of a scan and never
		// touch the buffer - a human chord (Ctrl+A, Alt+Tab, ...) mid-typing
		// shouldn't wipe out a scan already in progress, nor should it count
		// as a slow keystroke that resets it.
		if (event.ctrlKey || event.altKey || event.metaKey) {
			return 'ignored';
		}

		// IME composition input is never scanner input.
		if (event.isComposing) {
			return 'ignored';
		}

		if (terminators.includes(event.key)) {
			// The terminator must arrive within the same burst as the buffered
			// characters. Without this check, a fast-typed fragment left in the
			// buffer would turn a much-later, fully human Enter into a false
			// scan - and (via listen.ts's preventTerminatorDefault) swallow a
			// legitimate form submit. Scanners send their suffix immediately.
			if (buffer.length > 0 && event.timeStamp - lastTimestamp > maxInterKeyMs) {
				clearBuffer();
				return 'ignored';
			}
			if (buffer.length >= minLength) {
				const code = buffer.join('');
				const info: ScanInfo = {
					durationMs: event.timeStamp - startTimestamp,
					length: code.length
				};
				clearBuffer();
				onScan(code, info);
				return 'scan';
			}
			clearBuffer();
			return 'ignored';
		}

		if (event.key.length === 1) {
			if (buffer.length === 0) {
				startTimestamp = event.timeStamp;
			} else if (event.timeStamp - lastTimestamp > maxInterKeyMs) {
				// Gap too large: this keystroke can't be part of the same scan
				// as whatever's buffered so far. Human typing never grows into
				// a scan - restart the buffer at this single character.
				buffer = [];
				startTimestamp = event.timeStamp;
			}
			buffer.push(event.key);
			lastTimestamp = event.timeStamp;
			return 'buffered';
		}

		// Multi-character, non-terminator key (Shift, F5, ArrowLeft, ...).
		// Leave the buffer and timestamps untouched: Shift itself carries no
		// printable character (scanners send it to type uppercase letters),
		// so it must not reset an in-progress scan or count as a slow key.
		return 'ignored';
	}

	function reset(): void {
		clearBuffer();
	}

	return { handleKey, reset };
}
