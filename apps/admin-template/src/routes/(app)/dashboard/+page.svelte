<script lang="ts">
	/**
	 * M4 dashboard (spec §6): real charts built from the `items` data, in
	 * place of the M1-M3 placeholder cards. Same "load once, whole dataset"
	 * pattern as the items page ($effect load/dispose around
	 * createListResource) since the dashboard needs the full set to
	 * aggregate, not a paginated window.
	 */
	import {
		BarChart,
		ComboChart,
		GanttChart,
		Gauge,
		Heatmap,
		LineChart,
		PieChart,
		RadarChart,
		ScatterChart,
		Sparkline,
		StackedAreaChart
	} from '@banto/charts';
	import { createListResource } from '@banto/admin-core';
	import {
		DockHost,
		clampWindowToHost,
		collectPanelIds,
		createDockState,
		type DockLayout,
		type PanelContent
	} from '@banto/dock-svelte';
	import { LayoutGrid, JapaneseYen, Package, TriangleAlert, Warehouse } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import {
		byCategory,
		categoryCountsTop,
		categoryTrendByMonth,
		computeStatTiles,
		inventorySchedule,
		monthlyWithMovingAvg,
		priceBuckets,
		scatterSample,
		stockByCategoryPriceBand,
		type MonthCategoryCount,
		updatesByMonth,
		weekdayMonthHeat
	} from '#lib/banto/dashboard.js';
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
	import { PageHeader, LoadingState } from '@banto/ui';

	const STOCK_TARGET = 3_000_000;

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const stats = $derived(computeStatTiles(list.rows));
	const categoryStock = $derived(byCategory(list.rows));
	const categoryPriceBand = $derived(stockByCategoryPriceBand(list.rows));
	const buckets = $derived(priceBuckets(list.rows));
	const monthCounts = $derived(updatesByMonth(list.rows));
	const scatterRows = $derived(scatterSample(list.rows));

	// v2 chart types (spec §6.1): combo (bar+line), radar, heatmap, gauge.
	const monthlyAvg = $derived(monthlyWithMovingAvg(list.rows));
	const weekdayHeat = $derived(weekdayMonthHeat(list.rows));
	const topCategories = $derived(categoryCountsTop(list.rows, 5));

	// M24 chart types (spec §6.1, roadmap.md M24): stacked area (積立エリア), Gantt.
	const categoryTrend = $derived(categoryTrendByMonth(list.rows));
	const schedule = $derived(inventorySchedule(list.rows));

	const yen = (n: number) => `¥${n.toLocaleString()}`;
	const countLabel = (n: number) => m['dashboard.countUnit']({ count: n.toLocaleString() });
	// UTC getters (not toLocaleDateString): the schedule's dates are UTC
	// midnight `YYYY-MM-DD` instants (see dashboard.ts inventorySchedule), and
	// a locale-dependent format would make the visual regression snapshot
	// unstable across environments.
	const formatGanttDate = (ms: number) => {
		const d = new Date(ms);
		return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
	};

	/**
	 * M8 dock demo (spec §5, @banto/dock-svelte): the default layout docks the
	 * two chart panels side by side (a row split) with the メモ panel
	 * floating over them, so docked + floating coexist out of the box. Panels
	 * can be dragged to re-split, tabbed (drop on a pane center), undocked
	 * (drag a tab out to floating), and the split divider resizes live. The
	 * whole layout auto-saves; a stored M7 (v1, floating-only) value migrates
	 * cleanly via hydrate.
	 */
	const DOCK_STORAGE_KEY = 'banto.dock.dashboard';

	// Panel id/title/icon defs moved to #lib/banto/panels.ts (spec §5.3 v2):
	// shared with the standalone routes/panel/[id] route a popped-out panel
	// renders as, which has no access to this page's own locals.
	const PANEL_META: Record<string, { title: string; icon: string }> = Object.fromEntries(
		PANEL_DEFS.map((d) => [d.id, { title: d.title, icon: d.icon! }])
	);

	/** The seeded default: monthly | priceBuckets docked side by side, メモ floating. `hostW/H` clamp the floating window into view. */
	function defaultLayout(hostW: number, hostH: number): DockLayout {
		const memoDef = PANEL_DEFS.find((d) => d.id === 'memo')!;
		const memo = clampWindowToHost(
			{
				id: 'memo',
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
		return {
			version: 2,
			floating: [memo],
			docked: {
				type: 'split',
				id: 'root',
				direction: 'row',
				children: [
					{
						type: 'panel',
						id: 'monthly',
						title: PANEL_META.monthly.title,
						icon: PANEL_META.monthly.icon
					},
					{
						type: 'panel',
						id: 'priceBuckets',
						title: PANEL_META.priceBuckets.title,
						icon: PANEL_META.priceBuckets.icon
					}
				],
				sizes: [0.5, 0.5]
			}
		};
	}

	// M12 (spec §12.1): the UiSettingsProvider key the layout is ALSO saved
	// under (settings DB via Tauri/REST; localStorage in demo mode).
	// localStorage (DOCK_STORAGE_KEY) stays the synchronous first-paint
	// source; the provider copy is reconciled once after mount, below.
	const DOCK_SETTING_KEY = 'dock.dashboard';

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

	// Each docked pane / floating window body measures its own height so the
	// chart fills it (charts ResizeObserver their own width). Keyed by panel id.
	let panelHeights = $state<Record<string, number>>({});
	function chartHeight(id: string): number {
		return Math.max(140, (panelHeights[id] ?? 240) - 16);
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
	<PageHeader
		hideTitle
		title={m['nav.dashboard']()}
		description={m['dashboard.summary']({ count: list.totalCount.toLocaleString() })}
	/>

	<div class="stat-row">
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><Package size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statCount']()}</span>
				<span class="stat-value">{stats.count.toLocaleString()}</span>
			</div>
		</section>
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><Warehouse size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statStockTotal']()}</span>
				<div class="stat-value-row">
					<span class="stat-value">{stats.stockTotal.toLocaleString()}</span>
					<Sparkline values={monthCounts.map((mc) => mc.count)} width={72} height={24} />
				</div>
			</div>
		</section>
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><JapaneseYen size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statAvgPrice']()}</span>
				<span class="stat-value">{yen(stats.avgPrice)}</span>
			</div>
		</section>
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><TriangleAlert size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statLowStock']()}</span>
				<span class="stat-value">{stats.lowStockCount.toLocaleString()}</span>
			</div>
		</section>
	</div>

	<details class="about-demo">
		<summary>{m['dashboard.aboutSummary']()}</summary>
		<p class="note">{m['dashboard.aboutNote']({ count: list.totalCount.toLocaleString() })}</p>
	</details>

	{#if list.loading && list.rows.length === 0}
		<LoadingState label={m['items.loadingData']()} />
	{:else}
		<div class="chart-grid">
			<section class="card primary">
				<h2>{m['dashboard.monthlyTitle']()}</h2>
				<p class="card-caption">{m['dashboard.monthlyCaption']()}</p>
				<LineChart
					data={monthCounts}
					x={(row) => row.month}
					series={[{ id: 'count', label: m['dashboard.seriesUpdates'](), y: (row) => row.count }]}
					area
					label={m['dashboard.monthlyAria']()}
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.categoryStockTitle']()}</h2>
				<p class="card-caption">{m['dashboard.categoryStockCaption']()}</p>
				<BarChart
					data={categoryStock}
					category={(row) => row.category}
					series={[{ id: 'stock', label: m['dashboard.seriesStock'](), value: (row) => row.stock }]}
					horizontal
					label={m['dashboard.categoryStockAria']()}
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.stackedBarTitle']()}</h2>
				<p class="card-caption">{m['dashboard.stackedBarCaption']()}</p>
				<BarChart
					data={categoryPriceBand}
					category={(row) => row.category}
					series={[
						{ id: 'low', label: m['dashboard.priceBandLow'](), value: (row) => row.low },
						{ id: 'mid', label: m['dashboard.priceBandMid'](), value: (row) => row.mid },
						{ id: 'high', label: m['dashboard.priceBandHigh'](), value: (row) => row.high }
					]}
					stacked
					label={m['dashboard.stackedBarAria']()}
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.priceBucketTitle']()}</h2>
				<p class="card-caption">{m['dashboard.priceBucketCaption']()}</p>
				<PieChart
					data={buckets}
					category={(row) => row.bucket}
					value={(row) => row.count}
					donut
					label={m['dashboard.priceBucketAria']()}
					height={280}
					formatValue={countLabel}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.scatterTitle']()}</h2>
				<p class="card-caption">{m['dashboard.scatterCaption']()}</p>
				<ScatterChart
					data={scatterRows}
					x={(row) => row.price}
					y={(row) => row.stock}
					pointLabel={(row) => row.name}
					label={m['dashboard.scatterAria']()}
					height={280}
					formatX={(v) => yen(Number(v))}
					formatY={(v) => countLabel(Number(v))}
				/>
			</section>
		</div>

		<h2 class="section-heading">{m['dashboard.chartsV2Heading']()}</h2>
		<div class="chart-grid">
			<section class="card primary">
				<h2>{m['dashboard.comboTitle']()}</h2>
				<p class="card-caption">{m['dashboard.comboCaption']()}</p>
				<ComboChart
					data={monthlyAvg}
					x={(row) => row.month}
					bars={[{ id: 'count', label: m['dashboard.seriesUpdates'](), value: (row) => row.count }]}
					lines={[{ id: 'avg3', label: m['dashboard.series3mAvg'](), y: (row) => row.avg3 }]}
					label={m['dashboard.comboAria']()}
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.heatmapTitle']()}</h2>
				<p class="card-caption">{m['dashboard.heatmapCaption']()}</p>
				<Heatmap
					data={weekdayHeat}
					x={(row) => row.month}
					y={(row) => row.weekday}
					value={(row) => row.count}
					label={m['dashboard.heatmapAria']()}
					height={300}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.gaugeTitle']()}</h2>
				<p class="card-caption">{m['dashboard.gaugeCaption']({ target: yen(STOCK_TARGET) })}</p>
				<Gauge
					value={stats.stockTotal}
					max={STOCK_TARGET}
					label={m['dashboard.gaugeAria']()}
					height={220}
					formatValue={(n) => `${Math.round((n / STOCK_TARGET) * 100)}%`}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.radarTitle']()}</h2>
				<p class="card-caption">{m['dashboard.radarCaption']()}</p>
				<RadarChart
					data={topCategories}
					axis={(row) => row.category}
					series={[
						{ id: 'count', label: m['dashboard.seriesProductCount'](), value: (row) => row.count }
					]}
					label={m['dashboard.radarAria']()}
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>
		</div>

		<h2 class="section-heading">{m['dashboard.chartsM24Heading']()}</h2>
		<div class="chart-grid">
			<section class="card">
				<h2>{m['dashboard.categoryTrendTitle']()}</h2>
				<p class="card-caption">{m['dashboard.categoryTrendCaption']()}</p>
				<StackedAreaChart
					data={categoryTrend.rows}
					x={(row) => row.month}
					series={categoryTrend.categories.map((c) => ({
						id: c,
						label: c,
						y: (row: MonthCategoryCount) => row.values[c] ?? 0
					}))}
					label={m['dashboard.categoryTrendAria']()}
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card">
				<h2>{m['dashboard.scheduleTitle']()}</h2>
				<p class="card-caption">{m['dashboard.scheduleCaption']()}</p>
				<GanttChart
					tasks={schedule.tasks}
					label={m['dashboard.scheduleAria']()}
					today={schedule.today}
					formatDate={formatGanttDate}
				/>
			</section>
		</div>

		<section class="workspace">
			<h2 class="workspace-heading">
				<LayoutGrid size={18} aria-hidden="true" />{m['dashboard.workspaceHeading']()}
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
	{/if}
</div>

{#snippet dockPanel(content: PanelContent)}
	<!--
		Body extracted to DashboardPanel.svelte (spec §5.3 v2 pop-out): the
		SAME component renders this panel's content standalone at
		routes/panel/[id] once popped out into a real Tauri window, so the
		markup can't depend on anything from this page beyond the measured
		height below.
	-->
	<div class="dock-panel" bind:clientHeight={panelHeights[content.id]}>
		{#if content.id === MEMO_PANEL_ID}
			<DashboardMemoField
				draft={memo.draft}
				save={memoSave}
				saveTitle={memoSaveTitle}
				status={memoStatus}
			/>
		{:else}
			<DashboardPanel id={content.id} height={chartHeight(content.id)} />
		{/if}
	</div>
{/snippet}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* "About this demo" collapsible (design.md §10): the long technical note
	   used to sit at the top of the page, ahead of the KPIs/charts it
	   describes. Closed by default. */
	.about-demo {
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.about-demo summary {
		cursor: pointer;
		color: var(--banto-text);
		font-weight: 600;
		font-size: 0.85rem;
	}

	.about-demo summary:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.note {
		margin: 0.5rem 0 0;
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

	.stat-value-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.section-heading {
		margin: 0.25rem 0 0;
		font-size: 1rem;
		color: var(--banto-text-muted);
	}

	/* Asymmetric 12-column chart grid (design.md §10, plan Phase 3): the
	   primary (monthly-trend) chart spans 8/12, secondary charts 4/12 each,
	   collapsing to a single column under 900px. */
	.chart-grid {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		gap: 1rem;
	}

	.card {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: 1rem 1.25rem;
		min-width: 0;
		grid-column: span 12;
	}

	@media (min-width: 901px) {
		.card.primary {
			grid-column: span 8;
		}

		.card.secondary {
			grid-column: span 4;
		}
	}

	h2 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
		font-feature-settings: 'palt';
	}

	.card-caption {
		margin: 0 0 0.5rem;
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
		height: 520px;
	}

	.dock-panel {
		height: 100%;
		box-sizing: border-box;
		padding: 0.75rem;
	}
</style>
