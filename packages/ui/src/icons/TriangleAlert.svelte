<!--
  Icon "triangle-alert" from Lucide (@lucide/svelte v1.49.0), bundled so @banto/ui needs no
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
	class="lucide lucide-triangle-alert lucide-alert-triangle lucide-icon"
	{...rest}
>
	<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
	<path d="M12 9v4" />
	<path d="M12 17h.01" />
</svg>
