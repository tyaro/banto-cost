<script lang="ts">
	import '../app.css';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { bantoReady } from '#lib/banto/setup.js'; // initBanto() (+ EventProvider) before any route guard runs (spec §3, §11.1)
	import { initLocale } from '#lib/banto/locale.js'; // registers the Paraglide client strategy + syncs <html lang> (ADR-0005)
	import { settings } from '#lib/settings.svelte.js';
	import ToastHost from '#lib/components/ToastHost.svelte';
	import StartupSplash from '#lib/components/StartupSplash.svelte';
	import { isStartupDeferral } from '#lib/banto/startupGate.js';
	import {
		isNavigationSettled,
		trackFirstNavigation
	} from '#lib/banto/navigationSettled.svelte.js';

	let { children } = $props();

	// Start theme handling (applies persisted mode, watches OS changes) and sync
	// <html lang> to the persisted locale (ADR-0005; the strategy itself is
	// registered at locale.ts import time, above, before any message renders).
	$effect(() => {
		settings.init();
		initLocale();
	});

	// Issue #321: a protected route opened before startup finished was
	// deferred by its guard (`#lib/banto/startupGate.ts`) - nothing of it has
	// run. Keep the splash up instead of the error page, and re-run the loads
	// once startup has finished, so the same URL opens (or goes where the
	// guard sends it). A deferral can only come from a load started before
	// `bantoReady` resolved, so the re-run (which starts after it) clears it.
	//
	// The re-run waits until the navigation that produced the deferral has
	// COMPLETED and no other one is in flight (`isNavigationSettled()`): a
	// `refreshAll()` that starts while SvelteKit is still finishing a
	// navigation aborts it and leaves `beforeNavigate` - the unsaved-changes
	// guard - skipped (see `#lib/banto/navigationSettled.svelte.ts`). A fast
	// startup (Tauri, a local server) resolves `bantoReady` exactly then.
	// This layout is mounted by the first navigation, so it is also the one
	// that records its end for the whole app (`trackFirstNavigation`, which
	// wiring ① of `(app)/+layout.svelte` relies on too, #326).
	trackFirstNavigation();
	const startupDeferred = $derived(isStartupDeferral(page.error));
	let started = $state(false);
	void bantoReady.then(() => {
		started = true;
	});
	$effect(() => {
		if (startupDeferred && started && isNavigationSettled()) {
			void refreshAll();
		}
	});

	// Issue #219 (lan-reach-check-design §4.3, D2): the device side of the LAN
	// reach check (`/reach#t=<token>`) never touches the auth or data
	// providers - it only takes the token from the fragment and POSTs it. On
	// a LAN browser `bantoReady` first probes `/api/auth/check` and, while
	// that fails, waits for a manual reconnect on the splash; holding `/reach`
	// behind it would leave the token in the address bar and the history and
	// send nothing. So that route alone renders without waiting. It is outside
	// `(app)`, so no route guard is skipped, and every other route still waits.
	const startupIndependent = $derived(page.route.id === '/reach');
</script>

{#if startupIndependent}
	{@render children()}
{:else}
	{#await bantoReady}
		<StartupSplash />
	{:then}
		{#if startupDeferred}
			<StartupSplash />
		{:else}
			{@render children()}
			<ToastHost />
		{/if}
	{/await}
{/if}
