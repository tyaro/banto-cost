<script lang="ts">
	/**
	 * The apply / discard / cancel dialog of a draft settle
	 * (shared-primitives-upstream-plan §3.5, Issue #432 PR-10), on
	 * `@banto/ui`'s `Modal`. The state lives in a `SettlePrompt`
	 * (`#lib/banto/settlePrompt.svelte.ts`); closing the dialog by Esc / scrim /
	 * × answers `'cancel'`, which keeps every draft. All text is passed in
	 * resolved (conventions §13).
	 */
	import { Modal } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import type { SettlePrompt } from '#lib/banto/settlePrompt.svelte.js';

	interface Props {
		prompt: SettlePrompt;
		title: string;
		body: string;
		applyLabel: string;
		discardLabel: string;
	}

	let { prompt, title, body, applyLabel, discardLabel }: Props = $props();

	const overlayMessages = { overlayClose: () => m['common.close']() };
</script>

<Modal
	open={prompt.open}
	{title}
	width="28rem"
	messages={overlayMessages}
	onclose={() => prompt.answer('cancel')}
>
	<p class="body">{body}</p>
	<div class="actions">
		<button
			type="button"
			class="banto-btn banto-btn--secondary"
			onclick={() => prompt.answer('cancel')}
		>
			{m['common.cancel']()}
		</button>
		<button
			type="button"
			class="banto-btn banto-btn--danger"
			onclick={() => prompt.answer('discard')}
		>
			{discardLabel}
		</button>
		<button
			type="button"
			class="banto-btn banto-btn--primary"
			onclick={() => prompt.answer('apply')}
		>
			{applyLabel}
		</button>
	</div>
</Modal>

<style>
	.body {
		margin: 0 0 1rem;
		color: var(--banto-text);
		text-wrap: pretty;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
