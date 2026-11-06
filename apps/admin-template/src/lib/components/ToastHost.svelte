<script lang="ts">
	/** Toast stack (spec §3.4 notification sink), mounted once in the root layout: `@banto/ui`'s ToastHost over the app's store, with the Paraglide "close" label. */
	import * as m from '#lib/paraglide/messages.js';
	import { ToastHost } from '@banto/ui';
	import { toastStore } from '#lib/toast.svelte.js';
</script>

<ToastHost store={toastStore} messages={{ toastClose: () => m['common.close']() }} />
