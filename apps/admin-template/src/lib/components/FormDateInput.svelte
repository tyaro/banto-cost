<script lang="ts">
	/**
	 * The date input the app injects into @banto/forms (date-time-pickers §5.7,
	 * D1-a; `provideFieldInputs` in the root layout): `@banto/ui`'s `DateInput`
	 * with the app's copy (`messages`, conventions §13) and the current
	 * Paraglide locale for the month / weekday names (§5.5). forms passes the
	 * rest (`DateFieldInputProps`) - forms never imports @banto/ui.
	 */
	import type { DateFieldInputProps } from '@banto/forms';
	import { DateInput } from '@banto/ui';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { dateInputMessages } from '#lib/banto/i18n.js';

	let props: DateFieldInputProps = $props();

	const messages = dateInputMessages();
</script>

<DateInput {...props} locale={getLocale()} {messages} />
