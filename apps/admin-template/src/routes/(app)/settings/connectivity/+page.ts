import { guardCategory } from '../categories';

/** admin-only (see `+layout.ts`'s `visible.connectivity`); `guardCategory` bounces a non-admin here to the first visible category. */
export async function load({ parent }) {
	const { categories } = await parent();
	guardCategory(categories, 'connectivity');
}
