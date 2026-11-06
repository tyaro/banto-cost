import type { Component } from 'svelte';

export type StatusBadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Shape of an icon component accepted by the `icon` props. Any Svelte
 * component taking `size` and `aria-hidden` fits - lucide's components are
 * assignable as-is, so callers keep passing `@lucide/svelte` icons without
 * this package depending on it (docs/adr/0018-shared-ui-package.md §2).
 */
export type UiIconComponent = Component<{
	size?: number;
	'aria-hidden'?: 'true' | 'false' | boolean;
}>;
