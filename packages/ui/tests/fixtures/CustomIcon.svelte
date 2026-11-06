<script lang="ts">
	// Stand-in for a caller-supplied icon (e.g. a lucide component): any
	// component taking `size` / `aria-hidden` satisfies `UiIconComponent`.
	let { size = 24, ...rest }: { size?: number; 'aria-hidden'?: 'true' | 'false' | boolean } =
		$props();
</script>

<svg data-testid="custom-icon" data-size={size} width={size} height={size} {...rest}></svg>
