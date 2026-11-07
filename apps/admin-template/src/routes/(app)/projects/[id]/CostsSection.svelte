<script lang="ts">
	/**
	 * 案件詳細 → 直接費・発注 (spec §6.3 / §6.4 / §6.5, T05, T10, T14,
	 * banto-cost P4d): the project's approved direct costs by cost type and by
	 * month of the booked date (with the fiscal period, T15), what is still
	 * waiting for approval or provisional (暫定), every record that lands on
	 * the project (a split record with its share), and its purchase orders
	 * with the realized amount and the remainder (未実績発注残).
	 *
	 * An order is a commitment, not a cost: its realized amount is the sum of
	 * the approved costs that refer to it, so an invoice after the acceptance
	 * never adds the same cost twice (T05). Revising an order's amount and
	 * cancelling its remainder keep their reason. From here a record of the
	 * project can be entered against an order, an approved provisional
	 * confirmed by its invoice, and an approved record returned / cancelled /
	 * discounted (CostEntryForm.svelte).
	 *
	 * Reading needs `ViewProjectAmounts`; orders are the manager's or
	 * accounting's (`EditPurchaseOrder`), entries `EnterCost`. A `forbidden`
	 * read hides the section.
	 */
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import { LoadingState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { isPipelineAvailable } from '#lib/banto/pipelineAdmin.js';
	import { formatSignedYen, formatYen, isForbiddenError, todayIso } from '#lib/banto/costFormat.js';
	import {
		DIRECT_COST_TYPES,
		getProjectCosts,
		reviseOrder,
		saveOrder,
		type DirectCost,
		type DirectCostSaved,
		type DirectCostType,
		type ProjectCosts,
		type PurchaseOrder
	} from '#lib/banto/costsAdmin.js';
	import { listMasters, newRequestId, type WorkMaster } from '#lib/banto/timeAdmin.js';
	import { timeStatusLabel, timeStatusVariant } from '#lib/banto/timeFormat.js';
	import { costTypeLabel } from '#lib/banto/budgetFormat.js';
	import { kindLabel, parseYen, signedAmount } from '#lib/banto/costsFormat.js';
	import CostEntryForm from '#lib/components/CostEntryForm.svelte';

	interface Props {
		projectId: number;
		projectLabel: string;
		canWrite: boolean;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let { projectId, projectLabel, canWrite, onPendingChange }: Props = $props();

	const available = isPipelineAvailable();
	let data = $state<ProjectCosts | null>(null);
	let forbidden = $state(false);
	let loadError = $state<string | null>(null);
	let loadToken = 0;
	let phases = $state<WorkMaster[]>([]);
	let vendors = $state<WorkMaster[]>([]);

	let form = $state<
		| {
				cost: DirectCost | null;
				target: DirectCost | null;
				mode: 'cost' | 'confirms' | 'adjustment';
				orderId?: number;
		  }
		| undefined
	>(undefined);
	let formKey = $state(0);
	let formPending = $state({ dirty: false, busy: false });

	// Order form: `null` = a new order, a number = editing that order.
	let orderEditing = $state<number | null | undefined>(undefined);
	let orderVendor = $state('');
	let orderPhase = $state('');
	let orderType = $state<DirectCostType | ''>('');
	let orderDate = $state(todayIso());
	let orderAmount = $state('');
	let orderDescription = $state('');
	let orderErrors = $state<Record<string, string>>({});
	let orderRequest = newRequestId();
	// Revision: the order and its kind.
	let revising = $state<{ id: number; kind: 'amount' | 'cancel' } | null>(null);
	let reviseAmount = $state('');
	let reviseReason = $state('');
	let reviseErrors = $state<Record<string, string>>({});
	let busy = $state(false);

	const orderDirty = $derived(
		(orderEditing !== undefined && (orderAmount !== '' || orderDescription !== '')) ||
			(revising !== null && (reviseAmount !== '' || reviseReason !== ''))
	);
	$effect(() => {
		onPendingChange?.({
			dirty: (form !== undefined && formPending.dirty) || orderDirty,
			busy: busy || formPending.busy
		});
	});

	async function load(id: number) {
		if (!available) return;
		const token = ++loadToken;
		loadError = null;
		try {
			const next = await getProjectCosts(id);
			if (token !== loadToken) return;
			data = next;
			forbidden = false;
		} catch (err) {
			if (token !== loadToken) return;
			if (isForbiddenError(err)) forbidden = true;
			else loadError = isProviderError(err) ? err.message : String(err);
		}
	}

	$effect(() => {
		void load(projectId);
	});
	$effect(() => {
		if (!available) return;
		void Promise.all([listMasters('phases'), listMasters('vendors')])
			.then(([p, v]) => {
				phases = p;
				vendors = v;
			})
			.catch(() => {
				// The section reports access problems; the forms just have no choices.
			});
	});

	const projects = $derived([{ id: projectId, label: projectLabel }]);

	function openForm(next: NonNullable<typeof form>) {
		if (form !== undefined && formPending.dirty && !window.confirm(m['costs.discardConfirm']())) {
			return;
		}
		form = next;
		formKey += 1;
	}

	function costSaved(result: DirectCostSaved) {
		notify('success', result.replayed ? m['costs.replayed']() : m['costs.savedFromProject']());
		form = undefined;
		void load(projectId);
	}

	function fieldMap(errors: FieldError[]): Record<string, string> {
		const next: Record<string, string> = {};
		for (const e of errors)
			next[e.field] = next[e.field] ? `${next[e.field]} / ${e.message}` : e.message;
		return next;
	}

	function fail(err: unknown, set: (errors: Record<string, string>) => void) {
		if (isProviderError(err) && err.body.kind === 'validation')
			set(fieldMap(err.body.field_errors));
		else if (isForbiddenError(err)) notify('error', m['costs.forbiddenOrder']());
		else notify('error', isProviderError(err) ? err.message : String(err));
	}

	function startOrder(order: PurchaseOrder | null) {
		orderEditing = order ? order.id : null;
		orderVendor = order?.vendorId != null ? String(order.vendorId) : '';
		orderPhase = order?.phaseId != null ? String(order.phaseId) : '';
		orderType = order?.costType ?? '';
		orderDate = order?.orderedOn ?? todayIso();
		orderAmount = '';
		orderDescription = order?.description ?? '';
		orderErrors = {};
		orderRequest = newRequestId();
		revising = null;
	}

	async function sendOrder() {
		if (busy || orderEditing === undefined) return;
		const next: Record<string, string> = {};
		const amount = parseYen(orderAmount);
		if (orderEditing === null) {
			if (orderType === '') next.costType = m['costs.errorCostType']();
			if (amount === null || amount <= 0) next.amount = m['costs.errorAmount']();
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) next.orderedOn = m['costs.errorDate']();
		orderErrors = next;
		if (Object.keys(next).length > 0) return;
		const editing = orderEditing;
		const existing = data?.orders.find((o) => o.id === editing);
		busy = true;
		try {
			await saveOrder(editing, {
				projectId: editing === null ? projectId : undefined,
				costType: editing === null && orderType !== '' ? orderType : undefined,
				amount: editing === null ? (amount ?? undefined) : undefined,
				vendorId: orderVendor === '' ? null : Number(orderVendor),
				phaseId: orderPhase === '' ? null : Number(orderPhase),
				orderedOn: orderDate,
				description: orderDescription.trim() === '' ? null : orderDescription.trim(),
				clientRequestId: editing === null ? orderRequest : undefined,
				rowVersion: existing?.rowVersion
			});
			notify('success', m['costs.orderSaved']());
			orderEditing = undefined;
			orderAmount = '';
			orderDescription = '';
		} catch (err) {
			fail(err, (e) => (orderErrors = e));
		} finally {
			busy = false;
			void load(projectId);
		}
	}

	function startRevise(order: PurchaseOrder, kind: 'amount' | 'cancel') {
		revising = { id: order.id, kind };
		reviseAmount = kind === 'cancel' ? String(order.remaining) : String(order.amount);
		reviseReason = '';
		reviseErrors = {};
		orderEditing = undefined;
	}

	async function sendRevise(order: PurchaseOrder) {
		if (busy || !revising) return;
		const next: Record<string, string> = {};
		const amount = parseYen(reviseAmount);
		if (amount === null || amount <= 0) next.amount = m['costs.errorAmount']();
		if (reviseReason.trim() === '') next.reason = m['costs.errorReason']();
		reviseErrors = next;
		if (Object.keys(next).length > 0 || amount === null) return;
		busy = true;
		try {
			await reviseOrder(order.id, {
				kind: revising.kind,
				amount,
				reason: reviseReason.trim(),
				rowVersion: order.rowVersion
			});
			notify(
				'success',
				revising.kind === 'cancel' ? m['costs.orderCancelled']() : m['costs.orderRevised']()
			);
			revising = null;
		} catch (err) {
			fail(err, (e) => (reviseErrors = e));
		} finally {
			busy = false;
			void load(projectId);
		}
	}

	const canConfirm = (c: DirectCost) =>
		c.status === 'approved' && c.entryKind === 'provisional' && c.confirmedBy === null;
	const canAdjust = (c: DirectCost) =>
		c.status === 'approved' &&
		c.entryKind !== 'adjustment' &&
		c.projectId !== null &&
		c.confirmedBy === null;

	/** This project's part of a record (its share when split). */
	function share(c: DirectCost): number {
		if (c.projectId !== null) return signedAmount(c);
		return c.allocations.find((a) => a.projectId === projectId)?.amount ?? 0;
	}

	function amountOf(list: { costType: DirectCostType; amount: number }[], t: DirectCostType) {
		return list.find((x) => x.costType === t)?.amount ?? 0;
	}
</script>

{#if available && !forbidden}
	<section class="panel" aria-labelledby="costs-heading">
		<div class="head">
			<h2 id="costs-heading">{m['costs.sectionTitle']()}</h2>
			{#if data}
				<StatusBadge
					variant={data.complete ? 'success' : 'warning'}
					label={data.complete ? m['costs.complete']() : m['costs.provisionalState']()}
				/>
			{/if}
		</div>
		{#if loadError}
			<p class="error" role="alert">{loadError}</p>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => void load(projectId)}
			>
				{m['common.reload']()}
			</button>
		{:else if !data}
			<LoadingState label={m['common.loading']()} />
		{:else}
			<div class="headline">
				<div>
					<span class="label">{m['costs.totalApproved']()}</span>
					<span class="value">{formatYen(data.total)}</span>
				</div>
				<div>
					<span class="label">{m['costs.committed']()}</span>
					<span class="value">{formatYen(data.committed)}</span>
				</div>
				{#if data.pending.count > 0}
					<p class="note">
						{m['costs.pendingNote']({
							count: data.pending.count,
							amount: formatYen(data.pending.amount)
						})}
					</p>
				{/if}
				{#if data.provisional.count > 0}
					<p class="note">
						{m['costs.provisionalNote']({
							count: data.provisional.count,
							amount: formatYen(data.provisional.amount)
						})}
					</p>
				{/if}
			</div>

			{#if data.months.length > 0}
				<div class="table-wrap">
					<table>
						<caption>{m['costs.byMonth']()}</caption>
						<thead>
							<tr>
								<th scope="col">{m['costs.colMonth']()}</th>
								{#each DIRECT_COST_TYPES as t (t)}
									<th scope="col" class="num">{costTypeLabel(t)}</th>
								{/each}
								<th scope="col" class="num">{m['costs.colTotal']()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.months as row (row.month)}
								<tr>
									<td>{m['costs.monthWithPeriod']({ month: row.month, period: row.period })}</td>
									{#each DIRECT_COST_TYPES as t (t)}
										<td class="num">{formatSignedYen(amountOf(row.byType, t))}</td>
									{/each}
									<td class="num">{formatSignedYen(row.total)}</td>
								</tr>
							{/each}
							<tr class="total">
								<th scope="row">{m['costs.cumulative']()}</th>
								{#each DIRECT_COST_TYPES as t (t)}
									<td class="num">{formatSignedYen(amountOf(data.totals, t))}</td>
								{/each}
								<td class="num">{formatSignedYen(data.total)}</td>
							</tr>
						</tbody>
					</table>
				</div>
			{/if}

			<div class="subhead">
				<h3>{m['costs.ordersTitle']()}</h3>
				{#if canWrite}
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						onclick={() => startOrder(null)}>{m['costs.addOrder']()}</button
					>
				{/if}
			</div>
			<p class="note">{m['costs.ordersNote']()}</p>
			{#if orderEditing !== undefined}
				<form
					class="inline-form"
					onsubmit={(e) => {
						e.preventDefault();
						void sendOrder();
					}}
				>
					{#if orderEditing === null}
						<label class="field">
							<span>{m['costs.fieldCostType']()}</span>
							<select
								class="banto-input"
								bind:value={orderType}
								aria-invalid={!!orderErrors.costType}
							>
								<option value="">{m['time.choose']()}</option>
								{#each DIRECT_COST_TYPES as t (t)}
									<option value={t}>{costTypeLabel(t)}</option>
								{/each}
							</select>
							{#if orderErrors.costType}<span class="error">{orderErrors.costType}</span>{/if}
						</label>
						<label class="field">
							<span>{m['costs.fieldOrderAmount']()}</span>
							<input class="banto-input num" inputmode="numeric" bind:value={orderAmount} />
							{#if orderErrors.amount}<span class="error">{orderErrors.amount}</span>{/if}
						</label>
					{/if}
					<label class="field">
						<span>{m['costs.fieldOrderedOn']()}</span>
						<input class="banto-input" type="date" bind:value={orderDate} />
						{#if orderErrors.orderedOn}<span class="error">{orderErrors.orderedOn}</span>{/if}
					</label>
					<label class="field">
						<span>{m['costs.fieldVendor']()}</span>
						<select class="banto-input" bind:value={orderVendor}>
							<option value="">{m['costs.noVendor']()}</option>
							{#each vendors.filter((v) => v.active || String(v.id) === orderVendor) as v (v.id)}
								<option value={String(v.id)}>{v.name}</option>
							{/each}
						</select>
						{#if orderErrors.vendorId}<span class="error">{orderErrors.vendorId}</span>{/if}
					</label>
					<label class="field">
						<span>{m['time.fieldPhase']()}</span>
						<select class="banto-input" bind:value={orderPhase}>
							<option value="">{m['budget.noPhase']()}</option>
							{#each phases.filter((p) => p.active || String(p.id) === orderPhase) as p (p.id)}
								<option value={String(p.id)}>{p.name}</option>
							{/each}
						</select>
						{#if orderErrors.phaseId}<span class="error">{orderErrors.phaseId}</span>{/if}
					</label>
					<label class="field wide">
						<span>{m['costs.fieldDescription']()}</span>
						<input class="banto-input" bind:value={orderDescription} />
					</label>
					{#each Object.entries(orderErrors).filter(([f]) => !['costType', 'amount', 'orderedOn', 'vendorId', 'phaseId'].includes(f)) as [f, message] (f)}
						<p class="error wide" role="alert">{message}</p>
					{/each}
					<div class="actions wide">
						<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}
							>{m['costs.saveOrder']()}</button
						>
						<button
							type="button"
							class="banto-btn banto-btn--ghost"
							disabled={busy}
							onclick={() => (orderEditing = undefined)}>{m['common.cancel']()}</button
						>
					</div>
				</form>
			{/if}
			{#if data.orders.length === 0}
				<p class="note">{m['costs.noOrders']()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<caption class="sr-only">{m['costs.ordersTitle']()}</caption>
						<thead>
							<tr>
								<th scope="col">{m['costs.fieldOrderedOn']()}</th>
								<th scope="col">{m['costs.fieldVendor']()}</th>
								<th scope="col">{m['costs.fieldCostType']()}</th>
								<th scope="col" class="num">{m['costs.fieldOrderAmount']()}</th>
								<th scope="col" class="num">{m['costs.colCancelled']()}</th>
								<th scope="col" class="num">{m['costs.colRealized']()}</th>
								<th scope="col" class="num">{m['costs.colRemaining']()}</th>
								<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.orders as o (o.id)}
								<tr>
									<td>{o.orderedOn}</td>
									<td>
										{o.vendorName ?? ''}
										{#if o.description}<div class="sub wrap">{o.description}</div>{/if}
									</td>
									<td>
										{costTypeLabel(o.costType)}
										{#if o.phaseName}<div class="sub">{o.phaseName}</div>{/if}
									</td>
									<td class="num">{formatYen(o.amount)}</td>
									<td class="num">{formatYen(o.cancelledAmount)}</td>
									<td class="num">{formatYen(o.realized)}</td>
									<td class="num">
										{formatYen(o.remaining)}
										{#if o.pendingCount > 0}
											<div class="sub">
												{m['costs.orderPending']({
													count: o.pendingCount,
													amount: formatYen(o.pendingAmount)
												})}
											</div>
										{/if}
									</td>
									<td>
										{#if canWrite}
											<div class="row-actions">
												<button
													type="button"
													class="banto-btn banto-btn--secondary"
													onclick={() =>
														openForm({ cost: null, target: null, mode: 'cost', orderId: o.id })}
													>{m['costs.realize']()}</button
												>
												<button
													type="button"
													class="banto-btn banto-btn--ghost"
													onclick={() => startOrder(o)}>{m['costs.edit']()}</button
												>
												<button
													type="button"
													class="banto-btn banto-btn--ghost"
													onclick={() => startRevise(o, 'amount')}
													>{m['costs.reviseOrder']()}</button
												>
												{#if o.remaining > 0}
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														onclick={() => startRevise(o, 'cancel')}
														>{m['costs.cancelOrder']()}</button
													>
												{/if}
											</div>
										{/if}
									</td>
								</tr>
								{#if revising?.id === o.id}
									<tr class="sub-row">
										<td colspan="8">
											<form
												class="inline-form"
												onsubmit={(e) => {
													e.preventDefault();
													void sendRevise(o);
												}}
											>
												<label class="field">
													<span
														>{revising.kind === 'cancel'
															? m['costs.fieldCancelAmount']()
															: m['costs.fieldNewOrderAmount']()}</span
													>
													<input
														class="banto-input num"
														inputmode="numeric"
														bind:value={reviseAmount}
													/>
													{#if reviseErrors.amount}<span class="error">{reviseErrors.amount}</span
														>{/if}
												</label>
												<label class="field wide">
													<span>{m['costs.fieldReviseReason']()}</span>
													<input class="banto-input" bind:value={reviseReason} />
													{#if reviseErrors.reason}<span class="error">{reviseErrors.reason}</span
														>{/if}
												</label>
												{#if reviseErrors.rowVersion}
													<p class="error wide" role="alert">{reviseErrors.rowVersion}</p>
												{/if}
												<div class="actions wide">
													<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}
														>{m['costs.saveRevision']()}</button
													>
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														disabled={busy}
														onclick={() => (revising = null)}>{m['common.cancel']()}</button
													>
												</div>
											</form>
										</td>
									</tr>
								{/if}
								{#each o.changes as ch, i (i)}
									<tr class="change-row">
										<td colspan="8">
											{m['costs.orderChange']({
												kind:
													ch.kind === 'cancel'
														? m['costs.cancelOrder']()
														: m['costs.reviseOrder'](),
												before: formatYen(ch.beforeAmount),
												after: formatYen(ch.afterAmount),
												reason: ch.reason,
												by: ch.createdByName ?? '',
												at: ch.createdAt
											})}
										</td>
									</tr>
								{/each}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if form !== undefined}
				<div class="form-panel">
					{#key formKey}
						<CostEntryForm
							cost={form.cost}
							target={form.target}
							mode={form.mode}
							defaultDate={todayIso()}
							defaultProjectId={projectId}
							defaultOrderId={form.orderId ?? null}
							{projects}
							{phases}
							{vendors}
							orders={data.orders}
							onSaved={costSaved}
							onCancel={() => (form = undefined)}
							onPendingChange={(p) => (formPending = p)}
						/>
					{/key}
				</div>
			{/if}

			<div class="subhead">
				<h3>{m['costs.entriesTitle']()}</h3>
				{#if canWrite}
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						onclick={() => openForm({ cost: null, target: null, mode: 'cost' })}
						>{m['costs.add']()}</button
					>
				{/if}
			</div>
			{#if data.entries.length === 0}
				<p class="note">{m['costs.noEntries']()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<caption class="sr-only">{m['costs.entriesTitle']()}</caption>
						<thead>
							<tr>
								<th scope="col">{m['costs.fieldBookedOn']()}</th>
								<th scope="col">{m['costs.colKind']()}</th>
								<th scope="col">{m['costs.fieldCostType']()}</th>
								<th scope="col">{m['costs.fieldVendor']()}</th>
								<th scope="col" class="num">{m['costs.colShare']()}</th>
								<th scope="col">{m['costs.colPerson']()}</th>
								<th scope="col">{m['costs.colStatus']()}</th>
								<th scope="col"><span class="sr-only">{m['cost.colActions']()}</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.entries as c (c.id)}
								<tr>
									<td>{c.bookedOn}</td>
									<td>
										{kindLabel(c)}
										{#if c.refId !== null}<div class="sub">
												{m['costs.refOf']({ id: c.refId })}
											</div>{/if}
										{#if c.confirmedBy !== null}<div class="sub">{m['costs.confirmed']()}</div>{/if}
										{#if c.adjusted > 0}
											<div class="sub">
												{m['costs.adjustedBy']({ amount: formatYen(c.adjusted) })}
											</div>
										{/if}
									</td>
									<td>
										{costTypeLabel(c.costType)}
										{#if c.phaseName}<div class="sub">{c.phaseName}</div>{/if}
									</td>
									<td>
										{c.vendorName ?? ''}
										{#if c.description}<div class="sub wrap">{c.description}</div>{/if}
									</td>
									<td class="num">
										{formatSignedYen(share(c))}
										{#if c.projectId === null}
											<div class="sub">{m['costs.splitOf']()}</div>
										{/if}
									</td>
									<td>{c.userName}</td>
									<td>
										<StatusBadge
											variant={timeStatusVariant(c.status)}
											label={timeStatusLabel(c.status)}
										/>
									</td>
									<td>
										{#if canWrite}
											<div class="row-actions">
												{#if canConfirm(c)}
													<button
														type="button"
														class="banto-btn banto-btn--secondary"
														onclick={() => openForm({ cost: null, target: c, mode: 'confirms' })}
														>{m['costs.confirm']()}</button
													>
												{/if}
												{#if canAdjust(c)}
													<button
														type="button"
														class="banto-btn banto-btn--ghost"
														onclick={() => openForm({ cost: null, target: c, mode: 'adjustment' })}
														>{m['costs.adjust']()}</button
													>
												{/if}
											</div>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note">{m['costs.entriesNote']()}</p>
			{/if}
		{/if}
	</section>
{/if}

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: min(var(--banto-space-5), 3%);
	}

	.head,
	.subhead {
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
		flex-wrap: wrap;
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	h3 {
		margin: 0;
		font-size: var(--banto-font-size-md);
	}

	.headline {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--banto-space-5);
	}

	.headline div {
		display: flex;
		flex-direction: column;
	}

	.label {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.value {
		font-size: var(--banto-font-size-lg);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
	}

	caption {
		text-align: left;
		font-weight: 600;
		padding-bottom: var(--banto-space-1);
	}

	th,
	td {
		padding: var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.total th,
	.total td {
		font-weight: 600;
	}

	.sub {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
	}

	.wrap {
		white-space: normal;
		max-width: 20rem;
	}

	.row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1);
	}

	.sub-row td,
	.change-row td {
		background: var(--banto-surface-subtle);
	}

	.change-row td {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
		white-space: normal;
	}

	.inline-form {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: var(--banto-space-2);
		align-items: end;
	}

	.form-panel {
		border-top: var(--banto-border-width) solid var(--banto-border);
		padding-top: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field input,
	.field select {
		color: var(--banto-text);
	}

	.wide {
		grid-column: 1 / -1;
	}

	.actions {
		display: flex;
		gap: var(--banto-space-2);
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
