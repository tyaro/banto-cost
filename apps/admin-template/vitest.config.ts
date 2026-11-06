import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Separate from vite.config.ts (used by `vite dev`/`build`) - deliberately
// minimal, mirroring the `packages/*` unit-test configs (spec §9: Vitest for
// logic-layer tests). Only `sveltekit()` is needed here: it provides the
// `$app/*` modules the `.svelte.ts` store modules under test import (`#lib/*`
// is plain package.json `imports` since SvelteKit 3, e.g.
// `systemInfoStore.svelte.ts` -> `#lib/banto/systemAdmin.js`),
// and (via its bundled vite-plugin-svelte) compiles `.svelte.ts` runes
// sources. The app config's `paraglideVitePlugin`/`tailwindcss` plugins are
// irrelevant to these node-environment logic tests and only add overhead.
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'node'
	}
});
