<script lang="ts">
	/** Test-only host for `guardUnsavedChanges` (unsavedChangesGuard.test.ts). */
	import {
		guardUnsavedChanges,
		type BeforeNavigateHook,
		type UnsavedChangesGuard
	} from '../src/unsavedChanges.svelte';

	interface Props {
		isDirty: () => boolean;
		isSaving?: () => boolean;
		beforeNavigate: BeforeNavigateHook;
		confirm: (message: string) => boolean;
		message: string;
		onGuard?: (guard: UnsavedChangesGuard) => void;
	}

	let { isDirty, isSaving, beforeNavigate, confirm, message, onGuard }: Props = $props();

	// Props are read once here on purpose: the guard is set up at init.
	// svelte-ignore state_referenced_locally
	const guard = guardUnsavedChanges({
		isDirty: () => isDirty(),
		isSaving: () => isSaving?.() ?? false,
		beforeNavigate,
		confirm: (text) => confirm(text),
		message: () => message
	});
	// svelte-ignore state_referenced_locally
	onGuard?.(guard);
</script>
