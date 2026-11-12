<script lang="ts">
	/** Test-only injected date editor (cellEditors.test.ts): a marked text box that reports what the grid passed. */
	import type { CellDateEditorProps } from '../src/cellEditors';

	let { inputEl = $bindable(), ...props }: CellDateEditorProps = $props();
</script>

<input
	bind:this={inputEl}
	data-testid="stub-date"
	aria-label={props.label}
	value={props.text ?? ''}
	data-min={props.min}
	data-max={props.max}
	aria-describedby={props.describedBy}
	aria-invalid={props.invalid ? 'true' : undefined}
	readonly={props.readonly}
	oninput={(event) => props.onTextInput?.(event.currentTarget.value)}
	onkeydown={(event) => props.onkeydown?.(event)}
	onblur={(event) => props.onblur?.(event)}
/>
