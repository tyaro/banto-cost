<script lang="ts">
	/**
	 * Dashboard = 案件と売上の要約 (banto-cost, 2026-11; replaces the template's
	 * `items` chart demo). Four figures from the server, each in the caller's
	 * project scope (capability checks, design 第2章):
	 * - 未受注見込の総額 / 確度加重額: the pipeline overview (latest ADOPTED
	 *   version per pre-order project, `/api/pipeline/overview`).
	 * - 今月・来月の売上見通し: the monthly outlook total (計上済み＋受注済み予定＋
	 *   確度加重見込, `/api/outlook?from&to`). Never added to order-month figures.
	 * - 注意が必要な案件: projects with a pipeline or revenue-plan issue
	 *   (dashboardSummary.ts `attentionProjectIds`).
	 * A source the caller may not read shows 権限がありません for its tiles
	 * instead of 0円 (unset is never 0, banto-cost CLAUDE.md). Demo mode has no
	 * aggregates (pipelineAdmin.ts), so the tiles say so.
	 *
	 * Below: links to each business screen, and the メモ workspace.
	 */
	import { resolveAppPath } from '#lib/appPath.js';
	import type { Component } from 'svelte';
	import {
		DockHost,
		clampWindowToHost,
		collectPanelIds,
		createDockState,
		type DockLayout,
		type PanelContent
	} from '@banto/dock-svelte';
	import {
		CalendarClock,
		CalendarDays,
		NotebookPen,
		Percent,
		TrendingUp,
		TriangleAlert
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getPipelineOverview,
		isPipelineAvailable,
		type PipelineOverview
	} from '#lib/banto/pipelineAdmin.js';
	import { getOutlook, type OutlookView } from '#lib/banto/ordersAdmin.js';
	import { formatYen, isForbiddenError } from '#lib/banto/costFormat.js';
	import {
		attentionProjectIds,
		currentAndNextMonth,
		outlookMonthTotal
	} from '#lib/banto/dashboardSummary.js';
	import { NAV_ICONS } from '#lib/components/navIcons.js';
	import { PANEL_DEFS } from '#lib/banto/panels.js';
	import { getUiSettings, isTauri } from '#lib/banto/setup.js';
	import { listenPanelClosed, openPanelWindow } from '#lib/banto/popout.js';
	import { isDockEscapeBlocked } from '#lib/banto/dockEscape.js';
	import DashboardPanel from '#lib/components/DashboardPanel.svelte';
	import {
		MEMO_PANEL_ID,
		createDashboardMemo,
		createPanelChangeHandler,
		memoSaveCommand
	} from '#lib/banto/dashboardMemo.svelte.js';
	import { appShortcuts, firstPressOnly, SAVE_SHORTCUT } from '#lib/shortcuts.js';
	import { createSettlePrompt } from '#lib/banto/settlePrompt.svelte.js';
	import { untrack } from 'svelte';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import type { DraftSettleResult } from '@banto/forms';
	import DashboardMemoField from '#lib/components/DashboardMemoField.svelte';
	import DraftSettleDialog from '#lib/components/DraftSettleDialog.svelte';
	import { PageHeader } from '@banto/ui';

	// --- 案件と売上の要約 ------------------------------------------------------

	const available = isPipelineAvailable();
	const months = currentAndNextMonth(new Date());

	type Source<T> =
		{ state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; error: unknown };

	let overview = $state<Source<PipelineOverview>>({ state: 'loading' });
	let outlook = $state<Source<OutlookView>>({ state: 'loading' });
	let loadToken = 0;

	async function load(): Promise<void> {
		if (!available) return;
		const token = ++loadToken;
		overview = { state: 'loading' };
		outlook = { state: 'loading' };
		const [o, l] = await Promise.allSettled([
			getPipelineOverview(),
			getOutlook({ from: months.current, to: months.next })
		]);
		if (token !== loadToken) return;
		overview =
			o.status === 'fulfilled'
				? { state: 'ok', value: o.value }
				: { state: 'error', error: o.reason };
		outlook =
			l.status === 'fulfilled'
				? { state: 'ok', value: l.value }
				: { state: 'error', error: l.reason };
	}

	void load();

	/** Tile text for a source that is not loaded: demo / loading / forbidden / failed. */
	function pending<T>(source: Source<T>): string {
		if (!available) return m['dashboard.unavailable']();
		if (source.state === 'loading') return m['common.loading']();
		if (source.state === 'error' && isForbiddenError(source.error))
			return m['dashboard.forbidden']();
		return m['dashboard.loadFailed']();
	}

	function value<T>(source: Source<T>, pick: (value: T) => string): string {
		return source.state === 'ok' ? pick(source.value) : pending(source);
	}

	const overviewValue = $derived(overview.state === 'ok' ? overview.value : null);
	const outlookValue = $derived(outlook.state === 'ok' ? outlook.value : null);

	/** Counted only when both sources answered, so a forbidden half never reads as "0 projects". */
	const attention = $derived(
		overviewValue && outlookValue
			? attentionProjectIds(overviewValue, outlookValue).length.toLocaleString()
			: overview.state === 'error'
				? pending(overview)
				: pending(outlook)
	);

	interface Tile {
		id: string;
		icon: Component;
		label: string;
		value: string;
		note: string;
	}

	const tiles = $derived<Tile[]>([
		{
			id: 'pipeline-total',
			icon: TrendingUp,
			label: m['dashboard.pipelineTotal'](),
			value: value(overview, (o) => formatYen(o.totals.total)),
			note: overviewValue
				? m['dashboard.pipelineTotalNote']({
						count: overviewValue.totals.activeCount.toLocaleString(),
						missing: overviewValue.totals.missingAmount.length.toLocaleString()
					})
				: ''
		},
		{
			id: 'pipeline-weighted',
			icon: Percent,
			label: m['dashboard.pipelineWeighted'](),
			value: value(overview, (o) => formatYen(o.totals.weighted)),
			note: overviewValue
				? m['dashboard.pipelineWeightedNote']({
						missing: overviewValue.totals.missingProbability.length.toLocaleString()
					})
				: ''
		},
		{
			id: 'outlook-this-month',
			icon: CalendarDays,
			label: m['dashboard.outlookThisMonth'](),
			value: value(outlook, (v) => formatYen(outlookMonthTotal(v, months.current))),
			note: available ? m['dashboard.outlookMonthNote']({ month: months.current }) : ''
		},
		{
			id: 'outlook-next-month',
			icon: CalendarClock,
			label: m['dashboard.outlookNextMonth'](),
			value: value(outlook, (v) => formatYen(outlookMonthTotal(v, months.next))),
			note: available ? m['dashboard.outlookMonthNote']({ month: months.next }) : ''
		},
		{
			id: 'attention',
			icon: TriangleAlert,
			label: m['dashboard.attention'](),
			value: attention,
			note: m['dashboard.attentionNote']()
		}
	]);

	const links = [
		{
			path: '/pipeline',
			icon: NAV_ICONS.pipeline,
			label: () => m['nav.pipeline'](),
			note: () => m['dashboard.linkPipeline']()
		},
		{
			path: '/outlook',
			icon: NAV_ICONS.outlook,
			label: () => m['nav.outlook'](),
			note: () => m['dashboard.linkOutlook']()
		},
		{
			path: '/projects',
			icon: NAV_ICONS.projects,
			label: () => m['nav.projects'](),
			note: () => m['dashboard.linkProjects']()
		},
		{
			path: '/customers',
			icon: NAV_ICONS.customers,
			label: () => m['nav.customers'](),
			note: () => m['dashboard.linkCustomers']()
		}
	] as const;

	// --- メモ workspace ---------------------------------------------------------

	/**
	 * メモ workspace (spec §5, @banto/dock-svelte). banto-cost removed the
	 * template's chart panels (they aggregated the `items` demo data), so the
	 * default layout is the メモ as a floating window; it can be moved, resized,
	 * docked into the host and (Tauri) popped out, and the layout auto-saves. The storage keys
	 * carry `.v2` so a layout saved before the removal - which still names the
	 * chart panels - is ignored instead of showing empty panes.
	 */
	const DOCK_STORAGE_KEY = 'banto.dock.dashboard.v2';

	// Panel id/title/icon defs moved to #lib/banto/panels.ts (spec §5.3 v2):
	// shared with the standalone routes/panel/[id] route a popped-out panel
	// renders as, which has no access to this page's own locals.

	/** The seeded default: the メモ as a floating window at the bottom right. `hostW/H` clamp it into view. */
	function defaultLayout(hostW: number, hostH: number): DockLayout {
		const memoDef = PANEL_DEFS.find((d) => d.id === MEMO_PANEL_ID)!;
		const memo = clampWindowToHost(
			{
				id: MEMO_PANEL_ID,
				title: memoDef.title,
				icon: memoDef.icon,
				x: hostW - (memoDef.width ?? 320) - 24,
				y: hostH - (memoDef.height ?? 220) - 24,
				width: memoDef.width ?? 320,
				height: memoDef.height ?? 220,
				open: true
			},
			hostW,
			hostH
		);
		return { version: 2, floating: [memo], docked: null };
	}

	// M12 (spec §12.1): the UiSettingsProvider key the layout is ALSO saved
	// under (settings DB via Tauri/REST; localStorage in demo mode).
	// localStorage (DOCK_STORAGE_KEY) stays the synchronous first-paint
	// source; the provider copy is reconciled once after mount, below.
	const DOCK_SETTING_KEY = 'dock.dashboard.v2';

	function loadDockLayout(): string | undefined {
		if (typeof localStorage === 'undefined') return undefined;
		return localStorage.getItem(DOCK_STORAGE_KEY) ?? undefined;
	}

	const dock = createDockState(loadDockLayout());
	let dockHost: ReturnType<typeof DockHost> | undefined = $state();

	/**
	 * Issue #432 PR-10 (shared-primitives-upstream-plan §3.5・D9): the メモ
	 * pane is a text field whose unapplied input survives dock / undock / tab
	 * switches. The draft, its coordinator and the saved setting live HERE (the
	 * page), not in the pane: the pane is re-created by every structure change,
	 * and the draft's source stays registered while the page lives, so a closed
	 * memo with unapplied text still makes a router leave ask
	 * (dashboardMemo.svelte.ts). Apply = the UiSettingsProvider (spec §12.1).
	 */
	const memo = createDashboardMemo({
		provider: getUiSettings(),
		label: m['panels.memo'](),
		leaveMessage: () => m['unsaved.confirmLeave'](),
		messages: formValidationMessages()
	});
	const memoPrompt = createSettlePrompt();
	let memoStatus = $state<string | null>(null);

	/** What to tell the user after a save / close settle of the memo. */
	function noteMemoSettled(result: DraftSettleResult): void {
		memoStatus =
			result === 'failed'
				? m['dashboard.memoSaveFailed']()
				: result === 'dirty-again'
					? m['dashboard.memoChangedWhileSaving']()
					: null;
	}

	// Transition by transition (plan §3.5's table): dock / undock / move /
	// tab switch / hide only capture (no prompt); a close - which discards the
	// pane's content - settles first and closes only when the draft is clean.
	const beforePanelChange = createPanelChangeHandler({
		// Serialized: a close waits for a save already in flight (PR #449 review).
		coordinator: memo.serial,
		ask: (dirtyKeys) => memoPrompt.ask(dirtyKeys),
		onSettled: (_panelId, result) => noteMemoSettled(result)
	});

	async function saveMemo(): Promise<void> {
		noteMemoSettled(await memo.save());
	}

	// Issue #435 PR-11: the pane's save button and Ctrl+S / Cmd+S are ONE
	// command (memoSaveCommand) - the same serialized save, so a close asked
	// meanwhile waits for it. The key is registered with the app's shortcut
	// dispatcher for the page's lifetime (anywhere on this page, the memo's
	// textarea included); a held key saves once (firstPressOnly). Elsewhere
	// Ctrl+S stays the browser's.
	const memoSave = memoSaveCommand({
		memo,
		title: m['common.save'](),
		shortcut: SAVE_SHORTCUT,
		save: () => void saveMemo()
	});
	const memoSaveTitle = m['common.withShortcut']({
		label: m['common.save'](),
		keys: appShortcuts.format(SAVE_SHORTCUT)
	});
	$effect(() =>
		untrack(() =>
			appShortcuts.register('dashboard', [firstPressOnly(memoSave, appShortcuts.isRepeat)])
		)
	);

	// Page lifetime: register the draft's source, read the stored memo once, and
	// drop everything (an open question answers 'cancel') on unmount.
	$effect(() => untrack(() => memo.register()));
	$effect(() => {
		untrack(() => void memo.load());
		return () => {
			memoPrompt.dispose();
			memo.dispose();
		};
	});

	// A router leave with an unapplied memo asks first (Issue #214's guard; the
	// coordinator also joins the registry the desktop window close reads).
	guardUnsavedChanges({
		isDirty: () => memo.coordinator.pending,
		isSaving: () => memo.coordinator.settling || memo.setting.saving
	});

	let dockHostW = $state(0);
	let dockHostH = $state(0);
	let seeded = $state(false);

	// Seed the docked default once the host has a real measured size, but only
	// if nothing was restored from storage (an empty layout = fresh visit).
	// After seeding, a panel the user fully removed stays removed.
	$effect(() => {
		if (dockHostW === 0 || dockHostH === 0 || seeded) return;
		seeded = true;
		const known = new Set([
			...collectPanelIds(dock.layout.docked),
			...dock.layout.floating.map((w) => w.id)
		]);
		if (known.size === 0) {
			dock.layout = defaultLayout(dockHostW, dockHostH);
		}
	});

	// M12: after the localStorage-seeded first paint, read the provider's
	// copy once - if it holds a layout that differs from the local cache
	// (e.g. saved from another client/session), it wins: hydrate + refresh
	// the cache. A missing key or any provider failure keeps the local state.
	let providerChecked = false;
	$effect(() => {
		if (providerChecked) return;
		providerChecked = true;
		void (async () => {
			try {
				const remote = await getUiSettings().get(DOCK_SETTING_KEY);
				if (remote !== null && remote !== localStorage.getItem(DOCK_STORAGE_KEY)) {
					// Cache only what the dock accepted: a rejected (invalid) layout
					// would otherwise replace the valid local copy and reset the
					// dashboard on the next load.
					if (dock.hydrate(remote)) localStorage.setItem(DOCK_STORAGE_KEY, remote);
				}
			} catch {
				// Best-effort: offline/unauthenticated reads keep the local layout.
			}
		})();
	});

	// M12 provider autosave, debounced: a divider/window drag serializes on
	// every pointermove, and each of those must NOT become a settings-DB
	// write. localStorage (cheap, synchronous) still saves immediately below;
	// the provider gets one write 500ms after the layout stops changing (plus
	// a flush on unmount so the last change is never lost).
	const DOCK_SAVE_DEBOUNCE_MS = 500;
	let dockSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingDockJson: string | null = null;
	let dockSaveArmed = false;

	function flushDockSave(): void {
		if (pendingDockJson === null) return;
		const json = pendingDockJson;
		pendingDockJson = null;
		void getUiSettings()
			.set(DOCK_SETTING_KEY, json)
			.catch(() => {});
	}

	// Autosave the whole layout on every change (reading dock.serialize() ties
	// this effect to every move/resize/dock/undock/tab/close).
	$effect(() => {
		const json = dock.serialize();
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(DOCK_STORAGE_KEY, json);
		}
		// First run is the just-loaded layout, not a user change - arming
		// here avoids echoing it straight back into the settings DB.
		if (!dockSaveArmed) {
			dockSaveArmed = true;
			return;
		}
		pendingDockJson = json;
		clearTimeout(dockSaveTimer);
		dockSaveTimer = setTimeout(flushDockSave, DOCK_SAVE_DEBOUNCE_MS);
	});

	// Unmount: flush (not drop) a pending provider save, so navigating away
	// right after a drag still persists the final layout.
	$effect(() => {
		return () => {
			clearTimeout(dockSaveTimer);
			flushDockSave();
		};
	});

	function resetDockLayout() {
		dock.layout = defaultLayout(dockHostW, dockHostH);
	}

	function isDocked(id: string): boolean {
		return collectPanelIds(dock.layout.docked).includes(id);
	}
	/** A panel counts as visible when it's in the docked tree or an open floating window. */
	function isPanelVisible(id: string): boolean {
		return isDocked(id) || dock.isOpen(id);
	}
	/** Toolbar toggle: docked panels are always shown (button disabled); floating ones open/close, and a fully-removed one re-adds as floating. */
	function togglePanel(id: string): void {
		if (isDocked(id)) return;
		if (dock.isOpen(id)) {
			// Through the dock lifecycle (not dock.close): closing discards the
			// pane's content, so the memo's unapplied input is settled first.
			void dockHost?.closePanel(id);
			return;
		}
		const def = PANEL_DEFS.find((d) => d.id === id);
		if (def) {
			dock.ensureWindow(def, dockHostW, dockHostH);
			dock.open(id);
		}
	}

	/**
	 * v2 pop-out (spec §5.3, Tauri only): dragging a panel out via
	 * dock-svelte's `onPopOut` affordance (⧉ button) opens it as a REAL
	 * native window (`panel_open` Tauri command -> routes/panel/[id]) instead
	 * of a pseudo-window. The panel is hidden from THIS dock - undocked (if
	 * docked) then closed (if floating) - but its floating geometry is
	 * preserved, so `dock.open(id)` (below, on window-close) restores it
	 * exactly where it was. `undefined` in browser mode: DockHost then
	 * renders no pop-out button at all (see its doc comment), so this is
	 * never called there - `isTauri()` guards it anyway as a second line of
	 * defense.
	 */
	const onPopOut = isTauri()
		? async (content: PanelContent) => {
				// Popping out leaves this dock like a close does, so it goes through the
				// host's lifecycle (`closePanel`: beforePanelChange settles the memo's
				// unapplied input, and a structure change made while that waits makes
				// it `stale`). Only an applied close pops out; the close already
				// undocked + closed the pane with its geometry kept. (The pop-out
				// window shows DashboardPanel's static memo text, not this page's draft.)
				if ((await dockHost?.closePanel(content.id)) !== 'applied') return;
				void openPanelWindow(content);
			}
		: undefined;

	// Round-trip contract (spec §5.3 v2): when a popped-out panel's native
	// window is closed, src-tauri emits `banto://panel-closed` with that
	// panel's id (see popout.ts's listenPanelClosed) - `dock.open` brings it
	// back as a floating pseudo-window at its preserved geometry. (If the
	// panel had been docked, `onPopOut` above already demoted it to floating
	// via `undockPanel` before closing it - same permanent docked->floating
	// transition `DockedTree`'s own ✕ button uses - so it does NOT return to
	// the docked tree; this mirrors "closing a docked panel" everywhere else
	// in this package.) No-op in browser mode.
	$effect(() => {
		if (!isTauri()) return;
		return listenPanelClosed((id) => dock.open(id));
	});
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.dashboard']()} description={m['dashboard.summary']()}>
		{#snippet actions()}
			{#if available}
				<button type="button" class="banto-btn banto-btn--secondary" onclick={() => void load()}>
					{m['common.reload']()}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if !available}
		<p class="note">{m['dashboard.demoNote']()}</p>
	{/if}

	<div class="stat-row">
		{#each tiles as tile (tile.id)}
			<section class="stat-tile" data-tile={tile.id}>
				<span class="stat-icon" aria-hidden="true"><tile.icon size={18} /></span>
				<div class="stat-body">
					<span class="stat-label">{tile.label}</span>
					<span class="stat-value">{tile.value}</span>
					{#if tile.note}<span class="stat-note">{tile.note}</span>{/if}
				</div>
			</section>
		{/each}
	</div>

	<section aria-labelledby="dashboard-links">
		<h2 id="dashboard-links" class="section-heading">{m['dashboard.linksHeading']()}</h2>
		<ul class="link-grid">
			{#each links as link (link.path)}
				<li>
					<a class="link-card" href={resolveAppPath(link.path)}>
						<span class="stat-icon" aria-hidden="true"><link.icon size={18} /></span>
						<span class="link-body">
							<span class="link-label">{link.label()}</span>
							<span class="link-note">{link.note()}</span>
						</span>
					</a>
				</li>
			{/each}
		</ul>
	</section>

	<section class="workspace">
		<h2 class="workspace-heading">
			<NotebookPen size={18} aria-hidden="true" />{m['dashboard.workspaceHeading']()}
		</h2>
		<p class="workspace-caption">{m['dashboard.workspaceCaption']()}</p>
		<div class="dock-toolbar" role="toolbar" aria-label={m['dashboard.dockToolbarAria']()}>
			{#each PANEL_DEFS as def (def.id)}
				<button
					type="button"
					class="dock-toggle"
					class:active={isPanelVisible(def.id)}
					aria-pressed={isPanelVisible(def.id)}
					disabled={isDocked(def.id)}
					title={isDocked(def.id) ? m['dashboard.dockedAlwaysVisible']() : undefined}
					onclick={() => togglePanel(def.id)}
				>
					{def.icon}
					{def.title}
				</button>
			{/each}
			<button type="button" class="dock-reset" onclick={resetDockLayout}
				>{m['dashboard.reset']()}</button
			>
		</div>
		<div class="dock-wrapper" bind:clientWidth={dockHostW} bind:clientHeight={dockHostH}>
			<DockHost
				bind:this={dockHost}
				{dock}
				panel={dockPanel}
				{onPopOut}
				{beforePanelChange}
				isEscapeBlocked={isDockEscapeBlocked}
			/>
		</div>
		<DraftSettleDialog
			prompt={memoPrompt}
			title={m['dashboard.memoCloseTitle']()}
			body={m['dashboard.memoCloseBody']()}
			applyLabel={m['dashboard.memoCloseApply']()}
			discardLabel={m['dashboard.memoCloseDiscard']()}
		/>
	</section>
</div>

{#snippet dockPanel(content: PanelContent)}
	<!--
		Body extracted to DashboardPanel.svelte (spec §5.3 v2 pop-out): the
		SAME component renders this panel's content standalone at
		routes/panel/[id] once popped out into a real Tauri window, so the
		markup can't depend on anything from this page.
	-->
	<div class="dock-panel">
		{#if content.id === MEMO_PANEL_ID}
			<DashboardMemoField
				draft={memo.draft}
				save={memoSave}
				saveTitle={memoSaveTitle}
				status={memoStatus}
			/>
		{:else}
			<DashboardPanel id={content.id} />
		{/if}
	</div>
{/snippet}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
	}

	/* KPI tiles (design.md §10): icon + label + tabular-nums value. Tile-only
	   card (not SurfaceCard, spec §K3): same face/border/radius/shadow tokens
	   without SurfaceCard's optional title/description header. */
	.stat-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
	}

	.stat-tile {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: 1rem 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.85rem;
	}

	.stat-icon {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--banto-radius-md);
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
		color: var(--banto-primary);
	}

	.stat-body {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}

	.stat-label {
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.stat-value {
		font-size: 1.6rem;
		font-weight: 650;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
	}

	.stat-note {
		color: var(--banto-text-muted);
		font-size: 0.75rem;
		text-wrap: pretty;
	}

	.section-heading {
		margin: 0.25rem 0 0;
		font-size: 1rem;
		color: var(--banto-text-muted);
	}

	.link-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
	}

	.link-card {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		height: 100%;
		box-sizing: border-box;
		padding: 0.9rem 1.1rem;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		color: var(--banto-text);
		text-decoration: none;
	}

	.link-card:hover {
		border-color: var(--banto-primary);
	}

	.link-card:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.link-body {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.link-label {
		font-weight: 600;
	}

	.link-note {
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		text-wrap: pretty;
	}

	/* Docking area (design.md §10): separated from the regular chart cards
	   as an "analysis workspace" section on the subtle surface tone. */
	.workspace {
		background: var(--banto-surface-subtle);
		border-radius: var(--banto-radius-lg);
		padding: 1.25rem;
	}

	.workspace-heading {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.5rem;
		font-size: 1rem;
		font-feature-settings: 'palt';
	}

	.workspace-caption {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.875rem;
		text-wrap: pretty;
	}

	.dock-toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.75rem 0;
	}

	.dock-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		background: var(--banto-surface);
		color: var(--banto-text-muted);
		padding: 0.35rem 0.9rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.dock-toggle.active {
		border-color: var(--banto-primary);
		/* axe-core wcag2aa color-contrast (visual-refresh-plan.md §7.1): same
		   fix as Sidebar.svelte's .nav-item.active - plain --banto-primary text
		   on this tint background falls short of 4.5:1 in both themes. */
		color: var(--banto-primary-hover);
		background: color-mix(in srgb, var(--banto-primary) 8%, transparent);
	}

	.dock-toggle:focus-visible,
	.dock-reset:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.dock-reset {
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		background: var(--banto-surface);
		color: var(--banto-text);
		padding: 0.35rem 0.9rem;
		font-size: 0.8rem;
		cursor: pointer;
		margin-left: auto;
	}

	.dock-reset:hover {
		border-color: var(--banto-primary);
	}

	.dock-wrapper {
		height: 300px;
	}

	.dock-panel {
		height: 100%;
		box-sizing: border-box;
		padding: 0.75rem;
	}
</style>
