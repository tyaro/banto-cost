<script lang="ts">
	import DateRangeInput from '../../src/DateRangeInput.svelte';

	interface Props {
		value?: { from: string | null; to: string | null };
		label?: string;
		labelledBy?: string;
		orientation?: 'horizontal' | 'vertical';
		onValueChange?: (value: { from: string | null; to: string | null }) => void;
		onTextInput?: (end: 'from' | 'to', text: string) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		onblur?: (event: FocusEvent) => void;
		/** Records bubbled keydown / pointerdown on an ancestor (a grid or a filter popover). */
		onHostKeydown?: (event: KeyboardEvent) => void;
		onHostPointerdown?: (event: PointerEvent) => void;
	}

	let {
		value = $bindable({ from: null, to: null }),
		onHostKeydown,
		onHostPointerdown,
		...rest
	}: Props = $props();
</script>

<span id="range-name">Visit</span>
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
	<DateRangeInput bind:value {...rest} />
</div>
<button type="button">Outside</button>
<span data-testid="value">{value.from ?? 'null'}..{value.to ?? 'null'}</span>
