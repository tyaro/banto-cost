import { guardCategory } from '../categories';

/** Tauri && canManageAuthMode (see `+layout.ts`'s `visible.security`); `guardCategory` bounces anyone else to the first visible category. */
export async function load({ parent }) {
	const { categories } = await parent();
	guardCategory(categories, 'security');
}
