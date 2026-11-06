// Build tooling stays JavaScript so the runtime package needs no Node type dependency.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	base: '/__grid-error-fixture/',
	plugins: [svelte()],
	build: { minify: false }
});
