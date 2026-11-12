<script lang="ts">
	/** Test-only injected date input (dateField.test.ts): a marked text box that reports what forms passed. */
	import type { DateFieldInputProps } from '../src/fieldInputs';

	let props: DateFieldInputProps = $props();
</script>

<input
	data-testid="stub-date"
	id={props.id}
	value={props.text ?? props.value ?? ''}
	data-min={props.min}
	data-max={props.max}
	aria-describedby={props.describedBy}
	aria-invalid={props.invalid ? 'true' : undefined}
	readonly={props.readonly}
	disabled={props.disabled}
	oninput={(event) => props.onTextInput?.(event.currentTarget.value)}
	onblur={(event) => props.onblur?.(event)}
/>
