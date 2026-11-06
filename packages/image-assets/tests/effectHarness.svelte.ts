/**
 * Runs a callback inside a real `$effect` (jsdom + browser build, see `storeEffect.test.ts`)
 * and a `$derived` next to it, so a test can see whether writing from an effect makes the
 * effect re-run itself (PR #441 review: a tracked read of the version it writes loops forever).
 */
import { flushSync } from 'svelte';

export interface EffectRun<T> {
	/** How many times the effect body ran. */
	runs(): number;
	/** The current value of the `$derived`. */
	derived(): T;
	stop(): void;
}

export function runInEffect<T>(body: () => void, read: () => T): EffectRun<T> {
	let runs = 0;
	const value = $derived.by(read);
	let latest!: T;
	const stop = $effect.root(() => {
		$effect(() => {
			runs++;
			body();
		});
		$effect(() => {
			latest = value;
		});
	});
	flushSync();
	return {
		runs: () => runs,
		derived: () => {
			flushSync();
			return latest;
		},
		stop
	};
}
