<!--
  Icon "circle-alert" from Lucide (@lucide/svelte v1.49.0), bundled so @banto/ui needs no
  dependency (docs/adr/0018-shared-ui-package.md §2). Licensed under ISC (Lucide Icons and Contributors) and, for icons derived from Feather, MIT (Cole Bemis);
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
	class="lucide lucide-circle-alert lucide-alert-circle lucide-icon"
	{...rest}
>
	<circle cx="12" cy="12" r="10" />
	<line x1="12" x2="12" y1="8" y2="12" />
	<line x1="12" x2="12.01" y1="16" y2="16" />
</svg>
