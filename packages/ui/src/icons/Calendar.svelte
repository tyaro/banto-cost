<!--
  Icon "calendar" from Lucide (@lucide/svelte v1.64.0), bundled so @banto/ui needs no
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
	class="lucide lucide-calendar lucide-icon"
	{...rest}
>
	<path d="M8 2v3" />
	<path d="M16 2v3" />
	<rect x="3" y="3" width="18" height="18" rx="2" />
	<path d="M3 9h18" />
</svg>
