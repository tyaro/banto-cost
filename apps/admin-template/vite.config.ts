import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The app has no `@types/node` (conventions §3), and SvelteKit 3's
// `$app/tsconfig` (TypeScript 6) loads only `$app/types`. This file reads one
// environment variable, so declare just that. Module-scoped: it does not leak
// a `process` global into `src/`.
declare const process: { env: Record<string, string | undefined> };

// Base path for the static build. Empty for the Tauri desktop app and the
// LAN embedded-server (both serve at the site root). Set `BASE_PATH` (e.g.
// `/banto`) only for the GitHub Pages **project site** demo build, which is
// served under `https://<user>.github.io/<repo>/`.
// (SvelteKit itself rejects a value that does not start with `/`.)
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		// i18n compile (ADR-0005). Runs on dev/build and
		// (re)generates src/lib/paraglide/ from project.inlang + messages/*.json.
		// `strategy` MUST stay in sync with the `paraglide:compile` script in
		// package.json (used by `pnpm check`, which never runs Vite). `custom-banto`
		// is registered in src/lib/banto/locale.ts and resolves the locale entirely
		// client-side (ja default); `baseLocale` (en) is the server/prerender
		// fallback for the empty adapter-static SPA shell.
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['custom-banto', 'baseLocale'],
			emitTsDeclarations: true
		}),
		sveltekit({
			preprocess: vitePreprocess(),
			paths: { base },
			// Tauri has no SSR server: static build with SPA fallback (spec §8.1).
			// `index.html` serves as the SPA fallback for all three targets (Tauri
			// asset protocol, LAN `static_router`, and the Pages root). For the
			// GitHub Pages project site, the demo workflow additionally copies
			// `index.html` -> `404.html` so deep links (e.g. `/banto/items`) that
			// Pages routes to `404.html` load the same SPA.
			adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html' })
		})
	],
	// `@banto/*` ships source (exports point at `./src/index.ts` and raw
	// `.svelte.ts` runes modules are published as-is; docs/publishing.md,
	// ADR-0007). In a DERIVED app the packages become real node_modules deps
	// (git tag + `path:`), so Vite's dev dependency optimizer (Rolldown)
	// prebundles them - and vite-plugin-svelte's optimizer module path
	// (`compileSvelteModule`) hands `.svelte.ts` straight to
	// `svelte.compileModule` WITHOUT preprocessing, so TS-only syntax like
	// `import type` throws "Unexpected token" (js_parse_error) → HTTP 500
	// (issue #150). Excluding them routes the files through the normal dev
	// transform (Vite core strips the TS, then compile-module's `enforce:'post'`
	// plugin compiles) instead. In THIS repo `@banto/*` resolve to workspace
	// symlinks (realpath outside node_modules), so they are never prebundled and
	// this exclude is a no-op here - it exists for adopters.
	// INVARIANT (docs/conventions.md): every `@banto/*` dep that ships a
	// `.svelte.ts` under src/ MUST be listed here. verify:architecture enforces
	// this. Packages with only `.svelte` components (charts/attachments/report)
	// are fine - those go through the preprocessing path.
	optimizeDeps: {
		exclude: [
			'@banto/admin-core',
			'@banto/dock-svelte',
			'@banto/forms',
			'@banto/grid-svelte',
			'@banto/ui'
		]
	},
	// Fixed port so tauri.conf.json's devUrl always matches.
	server: {
		port: 1420,
		strictPort: true
	},
	clearScreen: false
});
