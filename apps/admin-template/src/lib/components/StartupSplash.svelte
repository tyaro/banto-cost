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
		gap: 0.75rem;
		padding: 1rem;
		text-align: center;
		color: var(--banto-text-muted);
	}
	h1 {
		font-size: 1.125rem;
		color: var(--banto-text);
	}
	button {
		padding: 0.5rem 1.25rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		background: transparent;
		color: var(--banto-text);
		cursor: pointer;
	}
</style>
