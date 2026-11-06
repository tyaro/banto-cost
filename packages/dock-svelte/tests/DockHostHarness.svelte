<!--
	Test-only harness for `DockHost.test.ts` (M-review 2026-08 M-8) and
	`DockHostReachability.test.ts`. `DockHost`'s `panel` prop is a
	`Snippet<[PanelContent]>`, which cannot be expressed from a `.ts` test file,
	so the component tests mount this wrapper instead and read assertions off the
	passed-in `DockState` (the reactive source of truth). `clamp` /
	`capabilities` and the gesture hooks (`canStartGesture` / `onGestureEnd` /
	`isEscapeBlocked`, #433-b) and the pane lifecycle props (`beforePanelChange` /
	`keepMounted` / `isStructureChangeDeferred`, #432) are forwarded unchanged;
	`host()` returns the `DockHost` instance (its `hidePanel` / `closePanel` /
	`resumeDeferredChange`).
-->
<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import DockHost from '../src/DockHost.svelte';
	import type { ClampOptions } from '../src/core/geometry';
	import type { DockCapabilities } from '../src/core/policy';
	import type { DockState } from '../src/state.svelte';
	import type { PanelContent } from '../src/types';

	type HostProps = ComponentProps<typeof DockHost>;

	let {
		dock,
		clamp,
		capabilities,
		canStartGesture,
		onGestureEnd,
		isEscapeBlocked,
		beforePanelChange,
		keepMounted,
		isStructureChangeDeferred
	}: {
		dock: DockState;
		clamp?: ClampOptions;
		capabilities?: (panelId: string) => DockCapabilities | undefined;
		canStartGesture?: HostProps['canStartGesture'];
		onGestureEnd?: HostProps['onGestureEnd'];
		isEscapeBlocked?: HostProps['isEscapeBlocked'];
		beforePanelChange?: HostProps['beforePanelChange'];
		keepMounted?: HostProps['keepMounted'];
		isStructureChangeDeferred?: HostProps['isStructureChangeDeferred'];
	} = $props();

	let hostRef: ReturnType<typeof DockHost> | undefined = $state();

	export function host(): ReturnType<typeof DockHost> {
		if (!hostRef) throw new Error('DockHost is not mounted');
		return hostRef;
	}
</script>

<DockHost
	bind:this={hostRef}
	{dock}
	{panel}
	{clamp}
	{capabilities}
	{canStartGesture}
	{onGestureEnd}
	{isEscapeBlocked}
	{beforePanelChange}
	{keepMounted}
	{isStructureChangeDeferred}
/>

{#snippet panel(content: PanelContent)}
	<div class="panel-body">{content.title}<input aria-label={`${content.title} input`} /></div>
{/snippet}
