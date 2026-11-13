/**
 * The confirmation of an operation that is hard to take back (banto-cost
 * P8f, review D-5 / §8-8): order conversion and its cancellation, approvals,
 * adoptions, month closing, settlement, posting. Instead of
 * `window.confirm`, `confirmAction` opens one `Modal`
 * (`ConfirmActionHost.svelte`, mounted once by the `(app)` layout) that shows
 * what the operation acts on (project code, amount, month) as a list and
 * always says whether and how it can be undone.
 *
 * - One question at a time: a new `confirmAction` while one is open answers
 *   the old one `false`.
 * - Closing the dialog any other way (Esc, scrim, ×) is `false`.
 * - Without a mounted host (a page rendered outside the `(app)` layout, a unit
 *   test) it falls back to `window.confirm` with the same text, so a caller
 *   never proceeds without an answer.
 *
 * Unsaved-input discards keep `window.confirm` for now (the review defers them).
 * State is written in `untrack` so a call from inside an `$effect` cannot
 * make the effect re-run itself (conventions §8). All text is passed in
 * resolved (conventions §13).
 */
import { untrack } from 'svelte';

export interface ConfirmDetail {
	label: string;
	value: string;
}

export interface ConfirmRequest {
	/** The dialog's heading and accessible name (e.g. 「受注転換」). */
	title: string;
	/** What happens, in a sentence or two. */
	body: string;
	/** What it acts on: project code, amount, month, count. */
	details?: ConfirmDetail[];
	/** Whether and how it can be undone (always shown). */
	undo: string;
	/** The label of the button that proceeds. */
	confirmLabel: string;
	/** Style the proceed button as destructive. */
	danger?: boolean;
}

class ConfirmState {
	#request = $state<ConfirmRequest | null>(null);
	#resolve: ((ok: boolean) => void) | null = null;
	#hosts = 0;

	get request(): ConfirmRequest | null {
		return this.#request;
	}

	get hosted(): boolean {
		return this.#hosts > 0;
	}

	attach(): () => void {
		this.#hosts += 1;
		return () => {
			this.#hosts -= 1;
			if (this.#hosts === 0) this.answer(false);
		};
	}

	ask(request: ConfirmRequest): Promise<boolean> {
		this.answer(false);
		return new Promise<boolean>((resolve) => {
			this.#resolve = resolve;
			untrack(() => (this.#request = request));
		});
	}

	answer(ok: boolean): void {
		const resolve = this.#resolve;
		this.#resolve = null;
		untrack(() => (this.#request = null));
		resolve?.(ok);
	}
}

export const confirmState = new ConfirmState();

/** The plain-text form of a request, for the `window.confirm` fallback. */
export function confirmText(request: ConfirmRequest): string {
	const details = (request.details ?? []).map((d) => `${d.label}: ${d.value}`);
	return [request.title, request.body, ...details, request.undo].join('\n');
}

/** Ask before an operation that is hard to take back; resolves `true` to proceed. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
	if (!confirmState.hosted) {
		return Promise.resolve(typeof window !== 'undefined' && window.confirm(confirmText(request)));
	}
	return confirmState.ask(request);
}
