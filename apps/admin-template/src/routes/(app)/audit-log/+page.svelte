<script lang="ts">
	/**
	 * 監査ログ閲覧画面（spec M14）。`admin` のみ到達（+page.ts が非adminを
	 * ダッシュボードへリダイレクト）。
	 *
	 * 一覧は BantoGrid の「サーバーモード」（items 一覧ページの
	 * ItemsServerGrid.svelte と同じ発想）: ソート/フィルタ/ページングは
	 * すべて `listAuditLog()`（Rust側 `ListParams` -> SQL）が行い、
	 * ブロック単位でスクロールに応じて遅延取得する。
	 *
	 * ブロック読み込みは `@banto/admin-core` の `createSnapshotListResource`
	 * （Issue #248、`packages/admin-core/src/snapshot.svelte.ts`）に任せる。
	 * 監査ログは通知（`invalidate`）なしに行が増え、保持期間の削除で減るので、
	 * 世代の最初の応答で境界（`asOfId`）を固定し、後続のブロックに渡す
	 * （ブロックの合間の追加で重複・欠落しない）。境界の中で件数が変わったら
	 * 失効として続きを読まず、「再読み込み」で新しい世代にする。以前は
	 * `WindowedListResource` の縮小コピー（`AuditLogWindow`）をこのページ内に
	 * 持っていて、失敗がトーストでしか見えず、`{0, 0}` から回復できず、
	 * 応答しない要求に期限が無く、境界も無かった（#248）。
	 *
	 * デモモード（プレーンな vite dev/preview、バックエンドなし）では
	 * 監査ログDBそのものが存在しないため、案内文のみ表示する
	 * （isAuditLogAvailable()、usersAdmin.ts と同じ流儀）。
	 */
	import { untrack } from 'svelte';
	import {
		BantoGrid,
		GridState,
		type FilterState,
		type GridColumn,
		type SortState
	} from '@banto/grid-svelte';
	import { createSnapshotListResource } from '@banto/admin-core';
	import { Info } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { PageHeader, EmptyState, StatusBadge } from '@banto/ui';
	import {
		getAuditConfig,
		isAuditLogAvailable,
		listAuditLog,
		type AuditLogEntry
	} from '#lib/banto/auditLogAdmin.js';

	const available = isAuditLogAvailable();

	const actionLabels: Record<string, string> = {
		create: m['audit.actionCreate'](),
		update: m['audit.actionUpdate'](),
		delete: m['audit.actionDelete'](),
		login: m['audit.actionLogin'](),
		login_failed: m['audit.actionLoginFailed'](),
		logout: m['audit.actionLogout'](),
		setup: m['audit.actionSetup'](),
		password_reset: m['audit.actionPasswordReset'](),
		settings_change: m['audit.actionSettingsChange'](),
		firewall_change: m['audit.actionFirewallChange'](),
		denied: m['audit.actionDenied']()
	};

	const resultLabels: Record<string, string> = {
		ok: m['audit.resultOk'](),
		denied: m['audit.resultDenied'](),
		failed: m['audit.resultFailed']()
	};

	const originLabels: Record<string, string> = {
		tauri: m['audit.originTauri'](),
		rest: m['audit.originRest']()
	};

	function actionLabel(action: string): string {
		return actionLabels[action] ?? action;
	}

	function resultLabel(result: string): string {
		return resultLabels[result] ?? result;
	}

	function originLabel(origin: string): string {
		return originLabels[origin] ?? origin;
	}

	const columns: GridColumn<AuditLogEntry>[] = [
		{ id: 'ts', header: m['audit.colTs'](), accessor: 'ts', width: 175 },
		{
			id: 'actorUsername',
			header: m['audit.colUser'](),
			accessor: (row) => row.actorUsername ?? '-',
			width: 140,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'actorRole',
			header: m['common.role'](),
			accessor: (row) => row.actorRole ?? '-',
			width: 90
		},
		{
			id: 'action',
			header: m['audit.colAction'](),
			accessor: 'action',
			width: 130,
			filterable: true,
			filterType: 'text',
			format: (value) => actionLabel(String(value))
		},
		{
			id: 'resource',
			header: m['audit.colResource'](),
			accessor: 'resource',
			width: 110,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'entityId',
			header: m['audit.colEntityId'](),
			accessor: (row) => row.entityId ?? '-',
			width: 90,
			align: 'right'
		},
		{
			id: 'origin',
			header: m['audit.colOrigin'](),
			accessor: 'origin',
			width: 110,
			format: (value) => originLabel(String(value))
		},
		{
			id: 'result',
			header: m['audit.colResult'](),
			accessor: 'result',
			width: 90,
			format: (value) => resultLabel(String(value))
		}
	];

	const gridState = new GridState<AuditLogEntry>(columns);
	// 既定ソート: 新しい記録が先頭に来るよう ts 降順（spec M14）。
	gridState.sort = [{ field: 'ts', direction: 'desc' }];

	/**
	 * 監査ログのブロック読み込み（Issue #248）。取得 1 本は
	 * `listAuditLog(params, asOfId, signal)`: 世代の最初は `asOfId: null`
	 * （サーバーが境界を決めて返す）、後続は固定した境界。境界付きの取得では
	 * サーバーは保持期間の削除を走らせない。期限（既定 30 秒）・失敗の持ち方・
	 * 世代違いの応答の破棄はリソース側が行う。リソース自身が作る失敗の文言
	 * （期限切れ・境界の食い違い・応答の形の不正）は `messages` で Paraglide の
	 * 文言に差し替える（banto #342）。
	 */
	const auditLog = createSnapshotListResource<AuditLogEntry>(
		(request, signal) =>
			listAuditLog(
				{ pagination: request.pagination, sort: request.sort, filters: request.filters },
				request.asOfId,
				signal
			),
		{
			params: { sort: gridState.sort, filters: [] },
			messages: {
				timeout: (ms) => m['audit.loadTimeout']({ seconds: Math.round(ms / 1000) }),
				boundaryMismatch: () => m['audit.boundaryMismatch'](),
				malformed: () => m['audit.malformedResult']()
			}
		}
	);

	// 画面に出す読み込み失敗: 失敗したままのブロックのうち、いちばん前のもの
	// （`failures` はブロック順）。失効（`expired`）は別の案内で出す。
	const loadFailure = $derived(auditLog.failures.find((failure) => failure.kind === 'error'));

	// `untrack` (spec M14, mirrors ItemsServerGrid.svelte's split-effects
	// comment): the initial load runs once on mount. The resource reads only
	// private copies of its params, but the effect must not start depending on
	// the state `ensureRange()` publishes (`loading` etc.) either. The cleanup
	// aborts whatever is still in flight when the page is left.
	$effect(() => {
		if (!available) return;
		untrack(() => auditLog.ensureRange(0, 100));
		return () => auditLog.dispose();
	});

	// 並べ替え・絞り込みの変更 = 新しい問い合わせ（前の行・件数・失敗は
	// 持ち越さない）。表示範囲が `{0, 0}`（0 件の後）でも先頭ブロックを取る。
	function handleParamsChange(params: { sort: SortState[]; filters: FilterState[] }): void {
		auditLog.setParams(params);
	}

	function handleVisibleRangeChange(range: { start: number; end: number }): void {
		auditLog.ensureRange(range.start, range.end);
	}

	// 「再読み込み」= 新しい世代（同じ問い合わせのまま新しい記録も入る）。
	// 失敗したブロックも取り直す。処理中でも押せる: 処理中の要求は中断され、
	// 新しい世代の要求に置き換わる（応答しない要求のせいで回復の手段が
	// 使えなくならない）。
	function reload(): void {
		auditLog.refresh();
	}

	// spec M14: result='denied'/'failed' の行を控えめな左ボーダーで視覚的に
	// 区別する（生色禁止・--banto-danger を使用）。BantoGrid の rowClass
	// prop が返すクラスに対して、下のスタイル内で :global() セレクタを
	// 当てている。
	// Display only: adds a left-accent highlight to whichever row is
	// currently selected, so the detail panel below reads as connected to
	// it (design.md §Phase 4 "選択行との関係が分かるレイアウト"). Reads the
	// existing `selected` state below - selection itself is unchanged.
	function auditRowClass(row: AuditLogEntry): string | undefined {
		const classes: string[] = [];
		if (row.result === 'denied' || row.result === 'failed') classes.push('audit-row-alert');
		if (selected?.id === row.id) classes.push('audit-row-selected');
		return classes.length > 0 ? classes.join(' ') : undefined;
	}

	let selected: AuditLogEntry | null = $state(null);

	function selectRow(row: AuditLogEntry): void {
		selected = row;
	}

	const selectedDetail = $derived.by((): string | null => {
		if (!selected?.detail) return null;
		try {
			return JSON.stringify(JSON.parse(selected.detail), null, 2);
		} catch {
			return selected.detail;
		}
	});

	// --- 保持ポリシー（表示のみ・設定変更は「設定」画面で行う） -----------
	let retentionNote: string | null = $state(null);

	$effect(() => {
		if (!available) return;
		void (async () => {
			try {
				const config = await getAuditConfig();
				const days =
					config.retentionDays !== null
						? m['audit.retentionDaysValue']({ days: config.retentionDays })
						: m['audit.retentionUnlimited']();
				const rows =
					config.retentionRows !== null
						? m['audit.retentionRowsValue']({ rows: config.retentionRows.toLocaleString() })
						: m['audit.retentionRowsUnlimited']();
				retentionNote = m['audit.retentionNote']({ days, rows });
			} catch {
				// 表示専用の補足情報なので、取得に失敗しても画面は壊さない。
				retentionNote = null;
			}
		})();
	});
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.auditLog']()} description={m['audit.pageDescription']()} />

	{#if !available}
		<EmptyState
			icon={Info}
			title={m['audit.unavailableTitle']()}
			description={m['audit.unavailableDesc']()}
		/>
	{:else}
		{#if retentionNote}
			<p class="note">{retentionNote}</p>
		{/if}

		<!--
			「まだ読めていない」「読めなかった」「0 件」を別々に出す（#248）。件数が
			`null` のうちは件数を言わない（0 件と言い切らない）。
		-->
		<p class="note" data-testid="audit-count-note">
			{#if auditLog.totalCount === null}
				{auditLog.failures.length > 0 ? m['audit.notLoadedNote']() : m['audit.loadingNote']()}
			{:else if auditLog.totalCount === 0}
				{m['audit.emptyNote']()}
			{:else}
				{m['audit.recordCountNote']({ count: auditLog.totalCount.toLocaleString() })}
			{/if}
		</p>

		{#if loadFailure?.kind === 'error'}
			<div class="load-error" role="alert">
				<p>
					<strong>{m['audit.loadError']()}</strong>
					<span>{m['audit.loadErrorDesc']()}</span>
					<span class="load-error-detail">{loadFailure.error.message}</span>
				</p>
			</div>
		{/if}
		{#if auditLog.expired}
			<div class="load-error" role="alert">
				<p>{m['audit.snapshotExpired']()}</p>
			</div>
		{/if}

		<!--
			「再読み込み」は常に出す（#248）: 失敗からの再試行だけでなく、境界を固定
			しているので新しい記録を取り込む唯一の導線でもある。処理中でも押せる。
		-->
		<div class="actions">
			<button type="button" class="banto-btn banto-btn--secondary" onclick={reload}>
				{m['common.reload']()}
			</button>
			<span class="note">{m['audit.reloadNote']()}</span>
		</div>

		<section class="grid-wrap">
			<BantoGrid
				mode="server"
				state={gridState}
				rows={auditLog.rows}
				totalRows={auditLog.totalCount ?? 0}
				{columns}
				getRowId={(row) => row.id}
				rowClass={auditRowClass}
				onRowClick={selectRow}
				onParamsChange={handleParamsChange}
				onVisibleRangeChange={handleVisibleRangeChange}
			/>
		</section>

		{#if selected}
			<section class="detail">
				<h3>{m['audit.detailHeading']({ id: selected.id })}</h3>
				<dl>
					<dt>{m['audit.colTs']()}</dt>
					<dd>{selected.ts}</dd>
					<dt>{m['audit.colUser']()}</dt>
					<dd>{selected.actorUsername ?? '-'}</dd>
					<dt>{m['common.role']()}</dt>
					<dd>{selected.actorRole ?? '-'}</dd>
					<dt>{m['audit.colAction']()}</dt>
					<dd>{actionLabel(selected.action)}</dd>
					<dt>{m['audit.colResource']()}</dt>
					<dd>{selected.resource}</dd>
					<dt>{m['audit.colEntityId']()}</dt>
					<dd>{selected.entityId ?? '-'}</dd>
					<dt>{m['audit.colOrigin']()}</dt>
					<dd>{originLabel(selected.origin)}</dd>
					<dt>{m['audit.colResult']()}</dt>
					<dd>
						<StatusBadge
							variant={selected.result === 'ok' ? 'success' : 'danger'}
							label={resultLabel(selected.result)}
						/>
					</dd>
				</dl>
				{#if selectedDetail}
					<h4>{m['audit.detailJson']()}</h4>
					<pre>{selectedDetail}</pre>
				{/if}
			</section>
		{/if}
	{/if}
</div>

<style>
	.page {
		height: calc(100vh - var(--banto-shell-header-height) - 2.5rem);
		display: flex;
		flex-direction: column;
		min-height: 0;
		gap: 0.5rem;
	}

	.note {
		flex: 0 0 auto;
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.load-error {
		flex: 0 0 auto;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--banto-danger-solid);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-danger-tint);
		color: var(--banto-danger-tint-text);
		font-size: 0.85rem;
	}

	.load-error p {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
	}

	.load-error-detail {
		opacity: 0.8;
	}

	.actions {
		flex: 0 0 auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}

	.grid-wrap {
		flex: 1;
		min-height: 0;
	}

	/* spec M14: BantoGrid's `rowClass` prop adds this class to a row's outer
	   `.row` element (packages/grid-svelte/src/BantoGrid.svelte); `:global()`
	   is required here since that element is rendered by a different
	   component (Svelte scopes styles per-component by default). Subdued
	   left border only, theme-variable based - no raw colors (spec M14). */
	:global(.row.audit-row-alert) {
		border-left: 3px solid var(--banto-danger);
	}

	/* Selected-row highlight (display-only, design.md §Phase 4): ties the
	   detail panel below to the row it describes. Same left-accent idiom as
	   .audit-row-alert above, primary hue instead of danger. */
	:global(.row.audit-row-selected) {
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
		border-left: 3px solid var(--banto-primary);
	}

	/* Detail panel (design.md §Phase 4 "選択行との関係が分かるレイアウト"):
	   a primary-accent top border visually connects it to the highlighted
	   row above, in the same surface/radius/shadow language as SurfaceCard. */
	.detail {
		flex: 0 0 auto;
		max-height: 40%;
		overflow-y: auto;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-top: 3px solid var(--banto-primary);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: 1rem 1.25rem;
	}

	.detail h3 {
		margin: 0 0 0.75rem;
		font-size: 0.95rem;
	}

	.detail h4 {
		margin: 0.75rem 0 0.5rem;
		font-size: 0.85rem;
		color: var(--banto-text-muted);
	}

	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.35rem 1rem;
		margin: 0;
		font-size: 0.85rem;
	}

	dt {
		color: var(--banto-text-muted);
	}

	dd {
		margin: 0;
	}

	pre {
		margin: 0;
		padding: 0.75rem;
		background: var(--banto-bg);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		font-size: 0.8rem;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
