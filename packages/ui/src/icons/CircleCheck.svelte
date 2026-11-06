<!--
  Icon "circle-check" from Lucide (@lucide/svelte v1.49.0), bundled so @banto/ui needs no
  dependency (docs/adr/0018-shared-ui-package.md §2). Licensed under ISC (Lucide Icons and Contributors);
  see ./LICENSE. Markup is lucide's rendered output verbatim; not an icon set - not exported.
-->
<script lang="ts">
	let { size = 24, ...rest }: { size?: number; 'aria-hidden'?: 'true' | 'false' | boolean } =
		$props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class="lucide lucide-circle-check lucide-check-circle-2 lucide-icon"
	{...rest}
>
	<circle cx="12" cy="12" r="10" />
	<path d="m16 9-5.5 5.5L8 12" />
</svg>
