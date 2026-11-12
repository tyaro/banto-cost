<script lang="ts">
	/**
	 * The date-and-time editor the app injects into @banto/grid-svelte's cells
	 * (date-time-pickers §5.8, D1-a, PR-5; `provideCellEditors` in the root
	 * layout, beside `CellDateInput`): `@banto/ui`'s `DateTimeInput` with the
	 * app's copy (`messages`, conventions §13) and the current Paraglide locale
	 * (§5.5). The grid passes the rest (`CellDateTimeEditorProps`) and binds
	 * `inputEl` to put focus on the text box - the grid never imports @banto/ui.
	 */
	import type { CellDateTimeEditorProps } from '@banto/grid-svelte';
	import { DateTimeInput } from '@banto/ui';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { dateTimeInputMessages } from '#lib/banto/i18n.js';

	let { inputEl = $bindable(), ...props }: CellDateTimeEditorProps = $props();

	const messages = dateTimeInputMessages();
</script>

<DateTimeInput bind:inputEl {...props} locale={getLocale()} {messages} />
