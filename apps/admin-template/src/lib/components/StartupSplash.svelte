<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { startupState, retryStartup } from '#lib/banto/startupState.svelte.js';
</script>

{#if startupState.status === 'unreachable'}
	<div class="banto-splash" role="alert">
		<h1>{m['app.startup.unreachable.title']()}</h1>
		<p>{m['app.startup.unreachable.body']()}</p>
		<button type="button" onclick={retryStartup}>{m['app.startup.retry']()}</button>
	</div>
{:else}
	<p class="banto-splash" role="status">{m['app.starting']()}</p>
{/if}

<style>
	.banto-splash {
		min-height: 100vh;
		display: grid;
		place-items: center;
		align-content: center;
		gap: var(--banto-space-3);
		padding: var(--banto-space-4);
		text-align: center;
		color: var(--banto-text-muted);
	}
	h1 {
		font-size: var(--banto-font-size-lg);
		color: var(--banto-text);
	}
	button {
		padding: var(--banto-space-2) var(--banto-space-5);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius);
		background: transparent;
		color: var(--banto-text);
		cursor: pointer;
	}
</style>
