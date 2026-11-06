import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

// Compiles the `.svelte.ts` (runes) sources for unit tests (spec §9: Vitest for logic-layer
// tests). Same shape as `@banto/forms`: `svelteTesting()` adds the browser resolve conditions
// that a test needs to run real effects in jsdom (opted into per file with a
// `// @vitest-environment jsdom` docblock); the other tests stay in `node`.
export default defineConfig({
	plugins: [svelte(), svelteTesting()],
	test: {
		environment: 'node'
	}
});
