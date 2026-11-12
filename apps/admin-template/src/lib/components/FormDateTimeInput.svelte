<script lang="ts">
	/**
	 * The date-and-time input the app injects into @banto/forms
	 * (date-time-pickers §5.7, D1-a, PR-5; `provideFieldInputs` in the root
	 * layout, beside `FormDateInput`): `@banto/ui`'s `DateTimeInput` with the
	 * app's copy (`messages`, conventions §13) and the current Paraglide
	 * locale for the month / weekday names (§5.5). forms passes the rest
	 * (`DateTimeFieldInputProps`) - forms never imports @banto/ui.
	 */
	import type { DateTimeFieldInputProps } from '@banto/forms';
	import { DateTimeInput } from '@banto/ui';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { dateTimeInputMessages } from '#lib/banto/i18n.js';

	let props: DateTimeFieldInputProps = $props();

	const messages = dateTimeInputMessages();
</script>

<DateTimeInput {...props} locale={getLocale()} {messages} />
