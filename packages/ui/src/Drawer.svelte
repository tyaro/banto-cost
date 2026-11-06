<script lang="ts">
	/**
	 * Slide-over from the right edge, full height (docs/adr/0018-shared-ui-package.md
	 * §10, phase 4; from banto-industrial banto-hub T13-1): for editing next to
	 * the list it came from. Fade + slide, default width 480px, capped at the
	 * viewport width minus 2rem on narrow screens. Same contract as Modal - see
	 * OverlayPanel.svelte and `OverlayProps` (overlay.ts).
	 */
	import OverlayPanel from './OverlayPanel.svelte';
	import type { DrawerProps } from './overlay';

	let { width = '480px', ...rest }: DrawerProps = $props();
</script>

<OverlayPanel variant="drawer" {width} {...rest} />
