/**
 * Promise 4 of the date/time pickers: `pointerdown` does not propagate out of
 * the component's root. Shared by `DateInput`, `DateTimeInput`,
 * `DateRangeInput` and `TimeInput` (`{@attach stopPointerdown}` on the root).
 *
 * A native listener on purpose: Svelte delegates `onpointerdown` to the app
 * root, which runs after a host's own native listeners, so only a native
 * listener can stop the event before they see it.
 *
 * Package-internal (not exported from `index.ts`).
 */
import type { Attachment } from 'svelte/attachments';

export const stopPointerdown: Attachment<HTMLElement> = (root) => {
	const stop = (event: Event): void => event.stopPropagation();
	root.addEventListener('pointerdown', stop);
	return () => root.removeEventListener('pointerdown', stop);
};
