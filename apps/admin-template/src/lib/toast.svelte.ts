/**
 * The app's toast store: one `@banto/ui` store (ADR-0018 §8, phase 2c),
 * shared by `ToastHost` (components/ToastHost.svelte) and every caller. Wired
 * as the admin-core `Notifier` in src/lib/banto/setup.ts, so success/error/
 * info messages from the list/form composables (spec §3.4) surface here.
 */
import { createToastStore } from '@banto/ui';

export const toastStore = createToastStore();
