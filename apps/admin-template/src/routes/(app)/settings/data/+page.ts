import { guardCategory } from '../categories';

/** admin && (audit || backups) available (see `+layout.ts`'s `visible.data`); `guardCategory` bounces anyone else to the first visible category. */
export async function load({ parent }) {
	const { categories } = await parent();
	guardCategory(categories, 'data');
}
