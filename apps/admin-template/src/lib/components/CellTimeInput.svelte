<script lang="ts">
	/**
	 * The time editor the app injects into @banto/grid-svelte's cells
	 * (date-time-pickers §5.8, D1-a, PR-5; `provideCellEditors` in the root
	 * layout, beside `CellDateInput`): `@banto/ui`'s `TimeInput` with the app's
	 * copy (`messages`, conventions §13). The grid passes the rest
	 * (`CellTimeEditorProps`) and binds `inputEl` to put focus on the text box -
	 * the grid never imports @banto/ui.
	 */
	import type { CellTimeEditorProps } from '@banto/grid-svelte';
	import { TimeInput } from '@banto/ui';
	import { timeInputMessages } from '#lib/banto/i18n.js';

	let { inputEl = $bindable(), ...props }: CellTimeEditorProps = $props();

	const messages = timeInputMessages();
</script>

<TimeInput bind:inputEl {...props} {messages} />
