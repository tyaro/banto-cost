<script lang="ts">
	/**
	 * The time input the app injects into @banto/forms (date-time-pickers §5.7,
	 * D1-a, PR-5; `provideFieldInputs` in the root layout, beside
	 * `FormDateInput`): `@banto/ui`'s `TimeInput` with the app's copy
	 * (`messages`, conventions §13). forms passes the rest
	 * (`TimeFieldInputProps`) - forms never imports @banto/ui.
	 */
	import type { TimeFieldInputProps } from '@banto/forms';
	import { TimeInput } from '@banto/ui';
	import { timeInputMessages } from '#lib/banto/i18n.js';

	let props: TimeFieldInputProps = $props();

	const messages = timeInputMessages();
</script>

<TimeInput {...props} {messages} />
