<script lang="ts">
	/**
	 * Shared body renderer for a single dashboard dock panel (spec §5.3 v2
	 * pop-out): renders inside the dashboard's `DockHost` (docked pane or
	 * floating pseudo-window) AND, unmodified, as the standalone content of a
	 * REAL Tauri `WebviewWindow` at `routes/panel/[id]` once a panel is popped
	 * out - that route has no access to the dashboard page's own locals.
	 *
	 * banto-cost removed the template's chart panels (monthly / price buckets /
	 * SPC / trend), which aggregated the `items` demo data. The only panel left
	 * is the メモ: the dashboard renders its editable field itself
	 * (DashboardMemoField.svelte), so this component shows the static memo
	 * text a popped-out window displays.
	 */
	import * as m from '#lib/paraglide/messages.js';
	import { MEMO_PANEL_ID } from '#lib/banto/dashboardMemo.svelte.js';

	interface Props {
		id: string;
		/** Kept for the callers' measured height (dashboard pane / `/panel/[id]` viewport); unused by the memo text. */
		height?: number;
	}

	let { id }: Props = $props();
</script>

{#if id === MEMO_PANEL_ID}
	<p class="memo">{m['dashboard.panelMemoBody']()}</p>
{:else}
	<p class="status">{m['dashboard.unknownPanel']()}</p>
{/if}

<style>
	/* Caption-style status/memo text (dashboard page's .card-caption, spec §10). */
	.status,
	.memo {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}

	.memo {
		line-height: 1.6;
	}
</style>
