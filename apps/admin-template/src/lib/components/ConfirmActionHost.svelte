<script lang="ts">
	/**
	 * The one dialog behind `confirmAction` (`#lib/banto/confirmAction.svelte.ts`,
	 * review D-5 / §8-8), on `@banto/ui`'s `Modal`. Mounted once by the `(app)`
	 * layout. Shows what the operation acts on and whether it can be undone;
	 * Esc / scrim / × answer "no". So does leaving the page (browser Back, a
	 * link): the question belongs to the page that asked it, and its action
	 * must not run after that page is gone (PR #46 review).
	 */
	import { beforeNavigate } from '$app/navigation';
	import { Modal } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmState } from '#lib/banto/confirmAction.svelte.js';

	const overlayMessages = { overlayClose: () => m['common.close']() };
	const request = $derived(confirmState.request);

	$effect(() => confirmState.attach());
	beforeNavigate(() => confirmState.answer(false));
</script>

<Modal
	open={request !== null}
	title={request?.title}
	width="30rem"
	messages={overlayMessages}
	onclose={() => confirmState.answer(false)}
>
	{#if request}
		<p class="body">{request.body}</p>
		{#if request.details && request.details.length > 0}
			<dl class="details">
				{#each request.details as detail (detail.label)}
					<dt>{detail.label}</dt>
					<dd>{detail.value}</dd>
				{/each}
			</dl>
		{/if}
		<p class="undo">
			<span class="undo-label">{m['confirm.undoLabel']()}</span>
			{request.undo}
		</p>
		<div class="actions">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => confirmState.answer(false)}
			>
				{m['common.cancel']()}
			</button>
			<button
				type="button"
				class="banto-btn {request.danger ? 'banto-btn--danger' : 'banto-btn--primary'}"
				data-testid="confirm-action"
				onclick={() => confirmState.answer(true)}
			>
				{request.confirmLabel}
			</button>
		</div>
	{/if}
</Modal>

<style>
	.body {
		margin: 0 0 var(--banto-space-3);
		color: var(--banto-text);
		text-wrap: pretty;
	}

	.details {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--banto-space-1) var(--banto-space-3);
		margin: 0 0 var(--banto-space-3);
		padding: var(--banto-space-2) var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-sm);
	}

	.details dt {
		color: var(--banto-text-muted);
	}

	.details dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.undo {
		margin: 0 0 var(--banto-space-4);
		color: var(--banto-text);
		text-wrap: pretty;
	}

	.undo-label {
		font-weight: 600;
		margin-right: var(--banto-space-1);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--banto-space-2);
	}
</style>
