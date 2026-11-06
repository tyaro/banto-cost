<script lang="ts">
	/**
	 * Body of the dashboard's メモ pane (shared-primitives-upstream-plan
	 * §3.5・D9, Issue #432 PR-10). It only DRAWS the page-owned `FormDraft`:
	 * this component is re-created on every dock / undock / tab switch, and
	 * the text and its dirty state live in the draft, so they come back with
	 * it. No source registration here (forms README: a `FormDraft` source is
	 * registered for the page's lifetime).
	 *
	 * The selection / scroll position are not restored after a re-mount (the
	 * draft's `view` slot is left unused); IME composition is protected by the
	 * dock holding structure changes until `compositionend`.
	 */
	import { UnsavedChangesNotice, type FormDraft } from '@banto/forms';
	import type { CommandSpec } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { MEMO_FIELD, MEMO_MAX_LENGTH, memoText } from '#lib/banto/dashboardMemo.svelte.js';

	interface Props {
		draft: FormDraft;
		/**
		 * The save command (`memoSaveCommand`, #435): the button is enabled by
		 * its `enabled` and runs its `run` - the same command Ctrl+S runs.
		 */
		save: CommandSpec;
		/** The button's tooltip (label and key, e.g. 「保存（Ctrl+S）」). */
		saveTitle?: string;
		/** Why the last save / close did not finish, or `null`. */
		status: string | null;
	}

	let { draft, save, saveTitle, status }: Props = $props();

	const error = $derived(draft.errors[MEMO_FIELD]);
</script>

<div class="memo-field">
	<textarea
		class="banto-input memo-input"
		aria-label={m['dashboard.memoFieldAria']()}
		placeholder={m['dashboard.memoPlaceholder']()}
		maxlength={MEMO_MAX_LENGTH}
		aria-invalid={!!error}
		bind:value={() => memoText(draft.values), (text: string) => draft.setValue(MEMO_FIELD, text)}
	></textarea>
	{#if error}
		<p class="message error" role="alert">{error}</p>
	{:else if status}
		<p class="message" role="status">{status}</p>
	{/if}
	<div class="footer">
		<UnsavedChangesNotice pending={draft.dirty} label={m['unsaved.notice']()} />
		<button
			type="button"
			class="banto-btn banto-btn--primary save"
			disabled={save.enabled ? !save.enabled() : false}
			title={saveTitle}
			onclick={() => void save.run()}
		>
			{m['common.save']()}
		</button>
	</div>
</div>

<style>
	.memo-field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		height: 100%;
		min-height: 0;
	}

	.memo-input {
		flex: 1 1 auto;
		min-height: 4rem;
		height: auto;
		padding: 0.5rem 0.6rem;
		resize: none;
		font-size: 0.85rem;
		line-height: 1.6;
	}

	.message {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.message.error {
		color: var(--banto-danger);
	}

	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		min-height: 2rem;
	}

	.save {
		margin-left: auto;
	}
</style>
