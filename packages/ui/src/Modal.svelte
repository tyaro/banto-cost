<script lang="ts">
	/**
	 * Centred modal dialog (docs/adr/0018-shared-ui-package.md §10, phase 4;
	 * from banto-industrial banto-hub T19 S1-b): for one-way tasks that need
	 * no surrounding context, such as a create wizard. Fade + scale, default
	 * width 560px. Same contract as Drawer - see OverlayPanel.svelte and
	 * `OverlayProps` (overlay.ts).
	 */
	import OverlayPanel from './OverlayPanel.svelte';
	import type { ModalProps } from './overlay';

	let { width = '560px', ...rest }: ModalProps = $props();
</script>

<OverlayPanel variant="modal" {width} {...rest} />
