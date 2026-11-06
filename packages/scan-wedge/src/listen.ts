// DOM wrapper around the headless core (src/core/detector.ts). Attaches a
// capture-phase `keydown` listener and forwards every event to
// `createWedgeDetector`.
import { createWedgeDetector, type WedgeOptions } from './core/detector';

export interface ListenWedgeOptions extends WedgeOptions {
	/**
	 * Call `event.preventDefault()` on the terminator keystroke that
	 * completes a scan (default `true`). Without this, the terminator (e.g.
	 * Enter) can trigger a form submit or button click right after the scan
	 * fires - usually not what you want for a background/global listener.
	 */
	preventTerminatorDefault?: boolean;
	/**
	 * Skip detection while an editable element (`<input>`, `<textarea>`, or
	 * `contenteditable`) has focus (default `false`). Use this for global
	 * listeners (e.g. on `window`) so scans don't interfere with normal
	 * form typing.
	 */
	ignoreEditable?: boolean;
}

/**
 * Attach wedge-scan detection to `target` (typically `window` for a
 * page-wide listener, or a specific element). Returns a cleanup function
 * that removes the listener - call it on unmount/teardown.
 *
 * **Caveat**: this only *detects* a scan; it does not stop the scanned
 * characters from being typed into whatever element currently has focus.
 * Each keystroke of a scan reaches the DOM (and any focused `<input>`)
 * before this listener sees it, so a scan directed at a page with no
 * focused field (or a non-editable one) will leak characters into the
 * browser's default handling (e.g. "type-ahead find" in some contexts) and,
 * if an input *is* focused, into that input's value. If you need to keep
 * scanned text out of an unrelated input, use `ignoreEditable: true` here,
 * or better, give scans a dedicated field via the `wedgeInput` action in
 * `src/actions.ts`, which owns the input and clears it after a scan.
 */
export function listenWedge(target: Window | HTMLElement, options: ListenWedgeOptions): () => void {
	const { preventTerminatorDefault = true, ignoreEditable = false, ...wedgeOptions } = options;
	const detector = createWedgeDetector(wedgeOptions);

	function handleKeydown(event: KeyboardEvent): void {
		if (ignoreEditable && isEditableTarget(event.target)) {
			return;
		}
		const result = detector.handleKey(event);
		if (result === 'scan' && preventTerminatorDefault) {
			event.preventDefault();
		}
	}

	target.addEventListener('keydown', handleKeydown as EventListener, { capture: true });
	return () => {
		target.removeEventListener('keydown', handleKeydown as EventListener, { capture: true });
	};
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}
