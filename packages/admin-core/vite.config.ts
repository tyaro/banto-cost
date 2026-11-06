import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Minimal config: only what `vitest` needs to compile .svelte.ts (runes)
// sources for unit tests (spec §9: Vitest for logic-layer tests).
export default defineConfig({
	plugins: [svelte()],
	test: {
		environment: 'node'
	}
});
