// @vitest-environment jsdom
/**
 * The store's writes called from a real `$effect` (shared-primitives-upstream-plan §5.1, the
 * PR #441 review): a write method must not read the reactive version tracked, or the effect
 * that calls it re-runs itself forever (`effect_update_depth_exceeded`). jsdom plus the browser
 * resolve condition (`svelteTesting()` in vite.config.ts) is what makes effects run here; the
 * node tests run Svelte's server build, where they do not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createImageStore, type ImageDecoder, type ImageImportLimits } from '../src/index';
import { runInEffect, type EffectRun } from './effectHarness.svelte';
import { png } from './images';

const limits: ImageImportLimits = {
	maxBytes: 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
};
const decode: ImageDecoder = async () => ({ width: 3, height: 2 });
const objectUrls = { create: () => 'blob:test', revoke: () => {} };

let running: EffectRun<unknown> | null = null;
afterEach(() => {
	running?.stop();
	running = null;
});

describe('ImageStore writes from an $effect', () => {
	it('importFrom, pin, acquireUrl, delete and collect run the effect once and update $derived', async () => {
		const source = createImageStore({ maxTotalBytes: 1024, objectUrls });
		const meta = await source.add(png(3, 2), limits, { decode });
		const hash = meta!.sha256;
		const store = createImageStore({ maxTotalBytes: 1024, objectUrls });
		const run = runInEffect(
			() => {
				store.importFrom(source, hash);
				const release = store.pin([hash]);
				const lease = store.acquireUrl(hash);
				expect(store.delete(hash)).toBe(false);
				lease.release();
				release();
				store.collect([]);
				store.importFrom(source, hash);
			},
			() => store.count
		);
		running = run;
		expect(run.runs()).toBe(1);
		expect(run.derived()).toBe(1);
	});

	it('add (begin, then keep) from an effect runs the effect once', async () => {
		const store = createImageStore({ maxTotalBytes: 1024, objectUrls });
		let pending: Promise<unknown> | null = null;
		const run = runInEffect(
			() => {
				pending = store.add(png(3, 2), limits, { decode, key: 'k' });
			},
			() => [store.busy('k'), store.count] as const
		);
		running = run;
		expect(run.derived()).toEqual([true, 0]);
		await pending;
		expect(run.runs()).toBe(1);
		expect(run.derived()).toEqual([false, 1]);
	});

	it('dispose from an effect runs the effect once and $derived sees it', () => {
		const store = createImageStore({ maxTotalBytes: 1024, objectUrls });
		const run = runInEffect(
			() => store.dispose(),
			() => store.disposed
		);
		running = run;
		expect(run.runs()).toBe(1);
		expect(run.derived()).toBe(true);
	});
});
