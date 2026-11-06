/**
 * The apply / discard / cancel question of a `DraftCoordinator.settle`
 * (shared-primitives-upstream-plan §3.5, Issue #432 PR-10) as reactive
 * state for a dialog (`DraftSettleDialog.svelte`, built on `@banto/ui`'s
 * `Modal`). `ask` is the `settle` callback: it opens the dialog and resolves
 * with the user's answer.
 *
 * - One question at a time: a new `ask` while one is open answers the old one
 *   `'cancel'` (its settle keeps everything) and shows the new one.
 * - Closing the dialog any other way (Esc, scrim, ×) is `'cancel'`.
 * - `dispose()` (page unmount) answers an open question `'cancel'`.
 *
 * State is written in `untrack` so calling `ask` from inside an `$effect`
 * cannot make the effect re-run itself (conventions §8).
 */
import { untrack } from 'svelte';
import type { DraftSettleChoice } from '@banto/forms';

export interface SettlePrompt {
	/** A question is showing. Reactive. */
	readonly open: boolean;
	/** The dirty draft keys the open question is about. Reactive. */
	readonly dirtyKeys: readonly string[];
	ask(dirtyKeys: readonly string[]): Promise<DraftSettleChoice>;
	answer(choice: DraftSettleChoice): void;
	dispose(): void;
}

class Prompt implements SettlePrompt {
	#keys = $state<readonly string[] | null>(null);
	#resolve: ((choice: DraftSettleChoice) => void) | null = null;
	#disposed = false;

	get open(): boolean {
		return this.#keys !== null;
	}

	get dirtyKeys(): readonly string[] {
		return this.#keys ?? [];
	}

	ask(dirtyKeys: readonly string[]): Promise<DraftSettleChoice> {
		if (this.#disposed) return Promise.resolve('cancel');
		this.answer('cancel');
		return new Promise<DraftSettleChoice>((resolve) => {
			this.#resolve = resolve;
			untrack(() => (this.#keys = [...dirtyKeys]));
		});
	}

	answer(choice: DraftSettleChoice): void {
		const resolve = this.#resolve;
		this.#resolve = null;
		untrack(() => (this.#keys = null));
		resolve?.(choice);
	}

	dispose(): void {
		this.answer('cancel');
		this.#disposed = true;
	}
}

export function createSettlePrompt(): SettlePrompt {
	return new Prompt();
}
