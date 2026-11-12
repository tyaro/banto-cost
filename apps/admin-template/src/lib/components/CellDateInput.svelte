<script lang="ts">
	/**
	 * The date editor the app injects into @banto/grid-svelte's cells
	 * (date-time-pickers §5.8, D1-a; `provideCellEditors` in the root layout,
	 * beside `FormDateInput` for forms): `@banto/ui`'s `DateInput` with the
	 * app's copy (`messages`, conventions §13) and the current Paraglide locale
	 * (§5.5). The grid passes the rest (`CellDateEditorProps`) and binds
	 * `inputEl` to put focus on the text box - the grid never imports @banto/ui.
	 */
	import type { CellDateEditorProps } from '@banto/grid-svelte';
	import { DateInput } from '@banto/ui';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { dateInputMessages } from '#lib/banto/i18n.js';

	let { inputEl = $bindable(), ...props }: CellDateEditorProps = $props();

	const messages = dateInputMessages();
</script>

<DateInput bind:inputEl {...props} locale={getLocale()} {messages} />
