/**
 * The <=900px shell breakpoint as reactive state (visual-refresh-design.md
 * §8.1-8.3). Sidebar.svelte (fold button in the top row, >900px only) and
 * Header.svelte (drawer button, <=900px only) both need to know which one of
 * the two is on screen, so that exactly ONE toggle control exists in the
 * accessibility tree at a time (not two shown/hidden by CSS). Same
 * breakpoint as Sidebar.svelte's `@media (max-width: 900px)` rules.
 *
 * `createSubscriber` attaches the matchMedia listener only while something
 * reads `current` inside an effect/template, and the value is read from the
 * query on every access (the app shell is client-only, ssr = false, so a
 * narrow first paint never shows the wide fold state).
 */
import { createSubscriber } from 'svelte/reactivity';

export const NARROW_QUERY = '(max-width: 900px)';

class NarrowViewport {
	readonly #subscribe = createSubscriber((update) => {
		const query = window.matchMedia(NARROW_QUERY);
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	get current(): boolean {
		if (typeof window === 'undefined') return false;
		this.#subscribe();
		return window.matchMedia(NARROW_QUERY).matches;
	}
}

export const narrowViewport = new NarrowViewport();
