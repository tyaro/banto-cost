<script lang="ts">
	import DateInput from '../../src/DateInput.svelte';
	import type { UiMessages } from '../../src/messages';

	interface Props {
		value?: string | null;
		min?: string;
		max?: string;
		isDateDisabled?: (date: string) => boolean;
		locale?: string;
		weekStartsOn?: number;
		disabled?: boolean;
		readonly?: boolean;
		messages?: UiMessages;
		onValueChange?: (value: string | null) => void;
		onTextInput?: (text: string) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		onblur?: (event: FocusEvent) => void;
		/** Wraps the input in an ancestor that records bubbled keydown / pointerdown (a grid cell). */
		onHostKeydown?: (event: KeyboardEvent) => void;
		onHostPointerdown?: (event: PointerEvent) => void;
	}

	let { value = $bindable(null), onHostKeydown, onHostPointerdown, ...rest }: Props = $props();
</script>

<div
	data-testid="host"
	role="presentation"
	{@attach (node) => {
		const key = (event: Event) => onHostKeydown?.(event as KeyboardEvent);
		const pointer = (event: Event) => onHostPointerdown?.(event as PointerEvent);
		node.addEventListener('keydown', key);
		node.addEventListener('pointerdown', pointer);
		return () => {
			node.removeEventListener('keydown', key);
			node.removeEventListener('pointerdown', pointer);
		};
	}}
>
	<DateInput bind:value label="Due date" {...rest} />
</div>
<button type="button">Outside</button>
<span data-testid="value">{value ?? 'null'}</span>
