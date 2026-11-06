// Svelte 5 actions built on top of the DOM wrapper (src/listen.ts). See
// docs/roadmap.md M21.
import type { Action } from 'svelte/action';
import { listenWedge } from './listen';
import type { WedgeOptions, ScanInfo } from './core/detector';

export interface WedgeInputOptions extends WedgeOptions {
	/**
	 * Clear the input's value and dispatch a `bubbles: true` `input` event
	 * after a scan completes (default `true`). Dispatching a real `input`
	 * event (rather than just setting `.value`) keeps a sibling
	 * `bind:value` in sync, since Svelte's two-way binding listens for that
	 * event rather than polling the property.
	 */
	clearOnScan?: boolean;
}

/**
 * Use on a dedicated `<input>` that exists to receive scanner input, e.g.
 * a "scan barcode" search box. Wires up `listenWedge` on the input itself
 * (capture-phase `keydown`, terminator `preventDefault` by default - see
 * `src/listen.ts`) and, on a completed scan, clears the field so it's ready
 * for the next scan.
 *
 * This is the recommended way to keep scanned text from leaking into a
 * field's value long-term: the characters are typed into the input like
 * any other keystroke (that part can't be prevented - see `listenWedge`'s
 * caveat), but `wedgeInput` immediately empties it again once the scan is
 * recognized.
 *
 * ```svelte
 * <input use:wedgeInput={{ onScan: (code) => search(code) }} />
 * ```
 */
export const wedgeInput: Action<HTMLInputElement, WedgeInputOptions> = (node, options) => {
	let cleanup = attach(options);

	function attach(opts: WedgeInputOptions): () => void {
		const { clearOnScan = true, onScan, ...wedgeOptions } = opts;
		return listenWedge(node, {
			...wedgeOptions,
			onScan(code: string, info: ScanInfo) {
				onScan(code, info);
				if (clearOnScan) {
					node.value = '';
					node.dispatchEvent(new Event('input', { bubbles: true }));
				}
			}
		});
	}

	return {
		update(next: WedgeInputOptions) {
			cleanup();
			cleanup = attach(next);
		},
		destroy() {
			cleanup();
		}
	};
};

export interface KeepFocusedOptions {
	/** Turn the behavior on/off without tearing down and re-adding the action (default `true`). */
	enabled?: boolean;
}

/**
 * Keeps `node` focused for kiosk-style setups where a scanner must always
 * be able to type into one element (e.g. a hidden/always-visible scan
 * input) regardless of stray clicks or taps elsewhere on the page. When
 * `node` blurs, and the new focus target (`FocusEvent.relatedTarget`) is
 * *not* itself an editable element (`<input>`, `<textarea>`,
 * `contenteditable`), focus is returned to `node` on the next animation
 * frame.
 *
 * **Side effects / when not to use this**: this fights the browser's
 * normal focus model. It will pull focus away from non-editable
 * interactive elements a user just clicked (buttons, links, menu items) -
 * fine for a kiosk with a single scan field and no other interactive UI,
 * actively hostile in a regular page with normal navigation. Set
 * `enabled: false` (e.g. while a modal/dialog is open) rather than
 * destroying the element, so focus-stealing pauses without churn. Never
 * enable this together with `ignoreEditable`-style assumptions that other
 * inputs exist to be typed into - `keepFocused` will steal focus back from
 * them the moment they lose it.
 *
 * ```svelte
 * <input use:keepFocused={{ enabled: kioskMode }} bind:this={scanInput} />
 * ```
 */
export const keepFocused: Action<HTMLElement, KeepFocusedOptions | undefined> = (node, options) => {
	let enabled = options?.enabled ?? true;

	function isEditable(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) {
			return false;
		}
		return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
	}

	function handleBlur(event: FocusEvent): void {
		if (!enabled || isEditable(event.relatedTarget)) {
			return;
		}
		requestAnimationFrame(() => {
			if (enabled) {
				node.focus();
			}
		});
	}

	node.addEventListener('blur', handleBlur);

	return {
		update(next: KeepFocusedOptions | undefined) {
			enabled = next?.enabled ?? true;
		},
		destroy() {
			node.removeEventListener('blur', handleBlur);
		}
	};
};
