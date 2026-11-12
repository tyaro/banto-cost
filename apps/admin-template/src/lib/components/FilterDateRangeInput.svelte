<script lang="ts">
	/**
	 * The day range the app injects into @banto/grid-svelte's column filter
	 * for date / date-and-time columns (date-time-pickers §5.9, PR-6;
	 * `provideCellEditors({ dateRange })` in the root layout, beside
	 * `CellDateInput`): `@banto/ui`'s `DateRangeInput` with the app's copy
	 * (`messages`, conventions §13) and the current Paraglide locale (§5.5).
	 * The grid passes the rest (`FilterDateRangeInputProps`) and binds
	 * `fromInputEl` to focus the start day - the grid never imports @banto/ui.
	 */
	import type { FilterDateRangeInputProps } from '@banto/grid-svelte';
	import { DateRangeInput } from '@banto/ui';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { dateRangeInputMessages } from '#lib/banto/i18n.js';

	let { fromInputEl = $bindable(), ...props }: FilterDateRangeInputProps = $props();

	const messages = dateRangeInputMessages();
</script>

<DateRangeInput bind:fromInputEl {...props} locale={getLocale()} {messages} />
