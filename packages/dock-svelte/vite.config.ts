import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

// Compiles .svelte / .svelte.ts (runes) sources for unit tests (spec §9:
// Vitest for logic-layer tests). `svelteTesting()` (improvement-plan P3-3,
// same setup as grid-svelte/tree-svelte) adds the browser resolve conditions
// + auto-cleanup that @testing-library/svelte needs to mount components in
// jsdom. The default `environment: 'node'` is kept for the pure-logic tests
// (dropzones/geometry/state/tree); the component test (`tests/DockHost.test.ts`,
// M-review 2026-08 M-8) opts into jsdom per-file via a `// @vitest-environment
// jsdom` docblock, so the logic tests never pay the jsdom setup cost.
export default defineConfig({
	plugins: [svelte(), svelteTesting()],
	test: {
		environment: 'node'
	}
});
