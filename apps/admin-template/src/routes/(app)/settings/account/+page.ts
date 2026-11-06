import { guardCategory } from '../categories';

/** Always visible, but still runs `guardCategory` for structural symmetry with the other 4 category pages. */
export async function load({ parent }) {
	const { categories } = await parent();
	guardCategory(categories, 'account');
}
