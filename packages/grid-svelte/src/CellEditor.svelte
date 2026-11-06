<script lang="ts">
	/**
	 * Inline cell editor markup (select / checkbox / text-number-date input).
	 * Template only: edit state transitions, key/blur handling and focus
	 * management stay in `BantoGrid.svelte` and arrive here as callbacks. The
	 * draft is never written here; `onDraftChange` lets the grid own it.
	 */
	import type { CellEditorType } from './types';
	import { resolveSelectValue } from './core/clipboard';

	let {
		editor,
		label,
		invalid,
		describedBy,
		pending,
		draft,
		options,
		editorEl = $bindable(),
		onDraftChange,
		onToggle,
		onKeydown,
		onBlur
	}: {
		editor: CellEditorType | undefined;
		label: string;
		invalid: boolean;
		describedBy: string | undefined;
		pending: boolean;
		draft: unknown;
		options: { value: string | number; label: string }[] | undefined;
		editorEl: HTMLInputElement | HTMLSelectElement | undefined;
		onDraftChange: (value: unknown) => void;
		onToggle: (checked: boolean) => void;
		onKeydown: (event: KeyboardEvent) => void;
		onBlur: (event: FocusEvent) => void;
	} = $props();

	const common = $derived({
		'aria-label': label,
		'aria-invalid': invalid,
		'aria-describedby': describedBy,
		class: 'cell-editor',
		onpointerdown: (event: PointerEvent) => event.stopPropagation(),
		onkeydown: onKeydown,
		onblur: onBlur
	});
</script>

{#if (editor ?? 'text') === 'select'}
	<select
		bind:this={editorEl}
		{...common}
		class:pending
		value={String(draft ?? '')}
		onchange={(event) => onDraftChange(resolveSelectValue(event.currentTarget.value, options))}
	>
		{#each options ?? [] as option (option.value)}
			<option value={String(option.value)}>{option.label}</option>
		{/each}
	</select>
{:else if (editor ?? 'text') === 'checkbox'}
	<input
		type="checkbox"
		bind:this={editorEl}
		{...common}
		class:pending
		checked={!!draft}
		onclick={(event) => event.stopPropagation()}
		onchange={(event) => onToggle(event.currentTarget.checked)}
	/>
{:else}
	<input
		type={editor === 'number' ? 'number' : editor === 'date' ? 'date' : 'text'}
		bind:this={editorEl}
		{...common}
		class:pending
		value={String(draft ?? '')}
		oninput={(event) => onDraftChange(event.currentTarget.value)}
	/>
{/if}

<style>
	.cell-editor {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		padding: 0 0.6rem;
		border: none;
		outline: none;
		background: var(--banto-surface);
		color: var(--banto-text);
		font: inherit;
	}

	/* Keep the native checkbox compact instead of stretching the editor box. */
	.cell-editor[type='checkbox'] {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		flex-shrink: 0;
		padding: 0;
		margin-inline: var(--banto-space-2);
		accent-color: var(--banto-primary);
	}

	.cell-editor.pending {
		opacity: 0.5;
		pointer-events: none;
	}
</style>
