import { redirect } from '@sveltejs/kit';
import { resolveAppPath } from '#lib/navigation.js';

/**
 * `/settings` itself renders nothing - it always redirects to the first
 * VISIBLE category (`+layout.ts`'s `categories`), same as the root
 * `routes/+page.ts` dispatching `/` to `/dashboard`. `await parent()` reads
 * the settings layout's already-computed visible subset rather than
 * recomputing visibility here.
 */
export async function load({ parent }) {
	const { categories } = await parent();
	const first = categories[0];
	if (first) redirect(307, resolveAppPath(first.path));
}
