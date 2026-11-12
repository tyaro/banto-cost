<script lang="ts">
	// Test harness (dateInput.test.ts, date-time-pickers §8 / PR-3): a DateInput
	// inside an open Modal - a form in a dialog. The parent owns `open`;
	// `onclose` closes it.
	import { DateInput, Modal } from '../../src/index';

	let { onclose }: { onclose?: () => void } = $props();

	let open = $state(true);
	let value = $state<string | null>('2026-11-07');
</script>

<Modal
	{open}
	title="Edit"
	onclose={() => {
		onclose?.();
		open = false;
	}}
>
	<label for="modal-date">Due date</label>
	<DateInput id="modal-date" bind:value />
</Modal>
