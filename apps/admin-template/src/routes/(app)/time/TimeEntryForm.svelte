<script lang="ts">
	/**
	 * 工数の入力フォーム (spec §6.1, banto-cost P4b): work date, a project and
	 * its phase or a common activity, hours and minutes, what was done and the
	 * rework kind. New entries are saved as drafts; the person submits them
	 * from the week list. A returned entry keeps its status until resubmitted.
	 *
	 * The server checks the rest (the input unit, the 24-hour day, inactive
	 * masters, the project scope) and answers with field errors; duplicate
	 * and standard-day differences come back as warnings that do not block
	 * the save. A create carries a `clientRequestId` that is kept until the
	 * save succeeds, so a resend after a lost response is not a second row
	 * (T13).
	 *
	 * With `correcting`, the form requests a correction of an approved entry
	 * (訂正, P6b-2, T11): it starts from the entry's values, needs a reason,
	 * and the correction is submitted at once for accounting to approve; the
	 * approved entry is never edited.
	 */
	import { untrack } from 'svelte';
	import { isProviderError, notify, type FieldError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import {
		correctEntry,
		newRequestId,
		saveEntry,
		type ReworkKind,
		type TimeEntry,
		type TimeEntrySaved,
		type WorkMaster
	} from '#lib/banto/timeAdmin.js';
	import { REWORK_KINDS, reworkLabel, toMinutes } from '#lib/banto/timeFormat.js';
	import { isForbiddenError } from '#lib/banto/costFormat.js';

	interface ProjectChoice {
		id: number;
		label: string;
	}

	interface Props {
		/** The entry to edit, or `null` for a new one. */
		entry: TimeEntry | null;
		/** Request a correction of the approved `entry` instead of editing it. */
		correcting?: boolean;
		/** The date a new entry starts with. */
		defaultDate: string;
		projects: ProjectChoice[];
		phases: WorkMaster[];
		activities: WorkMaster[];
		onSaved: (saved: TimeEntrySaved) => void;
		onCancel: () => void;
		onPendingChange?: (pending: { dirty: boolean; busy: boolean }) => void;
	}

	let {
		entry,
		correcting = false,
		defaultDate,
		projects,
		phases,
		activities,
		onSaved,
		onCancel,
		onPendingChange
	}: Props = $props();

	// The parent keys this form on the entry, so its starting values are read once.
	const start = untrack(() => entry);
	let kind = $state<'project' | 'activity'>(start?.activityId ? 'activity' : 'project');
	let workDate = $state(start?.workDate ?? untrack(() => defaultDate));
	let projectId = $state(start?.projectId != null ? String(start.projectId) : '');
	let phaseId = $state(start?.phaseId != null ? String(start.phaseId) : '');
	let activityId = $state(start?.activityId != null ? String(start.activityId) : '');
	// `bind:value` on a number input yields a number, or null when cleared.
	let hours = $state<number | null>(start ? Math.floor(start.minutes / 60) : null);
	let mins = $state<number | null>(start ? start.minutes % 60 : 0);
	let description = $state(start?.description ?? '');
	let rework = $state<ReworkKind | ''>(start?.reworkKind ?? '');
	let reason = $state('');
	const correction = untrack(() => correcting) && start !== null;
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let requestId = newRequestId();
	// The values last sent under `requestId`. A retry of the same values keeps
	// the id (the server returns the row it may already have saved); changed
	// values get a new id, so a correction is never answered with the old row.
	let requestFor: string | null = null;

	function snapshot(): string {
		return JSON.stringify([
			kind,
			workDate,
			projectId,
			phaseId,
			activityId,
			hours,
			mins,
			description,
			rework,
			reason
		]);
	}
	const initial = snapshot();
	$effect(() => {
		onPendingChange?.({ dirty: snapshot() !== initial, busy });
	});

	/** Active choices, plus the entry's current one even if it was made inactive since. */
	function choices(rows: WorkMaster[], current: number | null | undefined) {
		return rows.filter((row) => row.active || row.id === current);
	}
	const phaseChoices = $derived(choices(phases, start?.phaseId));
	const activityChoices = $derived(choices(activities, start?.activityId));

	function build() {
		const next: Record<string, string> = {};
		if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) next.workDate = m['time.errorDate']();
		const minutes = toMinutes(hours ?? '', mins ?? '');
		if (minutes === null || minutes <= 0) next.minutes = m['time.errorMinutes']();
		if (kind === 'project') {
			if (projectId === '') next.projectId = m['time.errorProject']();
			if (phaseId === '') next.phaseId = m['time.errorPhase']();
		} else if (activityId === '') {
			next.activityId = m['time.errorActivity']();
		}
		if (correction && reason.trim() === '') next.reason = m['time.errorCorrectionReason']();
		errors = next;
		if (Object.keys(next).length > 0 || minutes === null) return null;
		const isProject = kind === 'project';
		return {
			workDate,
			projectId: isProject ? Number(projectId) : null,
			phaseId: isProject ? Number(phaseId) : null,
			activityId: isProject ? null : Number(activityId),
			minutes,
			description: description.trim() === '' ? null : description.trim(),
			reworkKind: isProject && rework !== '' ? rework : null
		};
	}

	function applyServerErrors(fieldErrors: FieldError[]) {
		const next: Record<string, string> = {};
		for (const error of fieldErrors) {
			next[error.field] = next[error.field]
				? `${next[error.field]} / ${error.message}`
				: error.message;
		}
		errors = next;
	}

	async function save() {
		if (busy) return;
		const values = build();
		if (!values) return;
		const sending = JSON.stringify(values);
		if (requestFor !== null && requestFor !== sending) requestId = newRequestId();
		requestFor = sending;
		busy = true;
		try {
			const saved =
				correction && start
					? await correctEntry(start.id, {
							...values,
							rowVersion: start.rowVersion,
							reason: reason.trim(),
							clientRequestId: requestId
						})
					: start
						? await saveEntry(start.id, { ...values, rowVersion: start.rowVersion })
						: await saveEntry(null, { ...values, clientRequestId: requestId });
			requestId = newRequestId();
			requestFor = null;
			onSaved(saved);
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				applyServerErrors(err.body.field_errors);
			} else if (isForbiddenError(err)) {
				notify('error', m['time.forbiddenEntry']());
			} else {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		} finally {
			busy = false;
		}
	}

	/** Field errors no input owns (a stale `rowVersion`, the status). */
	const otherErrors = $derived(
		Object.entries(errors)
			.filter(
				([field]) =>
					![
						'workDate',
						'minutes',
						'projectId',
						'phaseId',
						'activityId',
						'description',
						'reworkKind',
						'reason'
					].includes(field)
			)
			.map(([, message]) => message)
	);
</script>

<form
	class="entry-form"
	aria-labelledby="time-form-heading"
	onsubmit={(e) => {
		e.preventDefault();
		void save();
	}}
>
	<h2 id="time-form-heading">
		{correction ? m['time.correctTitle']() : start ? m['time.editTitle']() : m['time.addTitle']()}
	</h2>
	{#if correction}
		<p class="note" role="note">{m['time.correctNote']()}</p>
	{/if}
	{#if start?.status === 'returned' && start.returnReason}
		<p class="returned" role="note">
			{m['time.returnedReason']({ reason: start.returnReason })}
		</p>
	{/if}
	{#each otherErrors as message (message)}
		<p class="error" role="alert">{message}</p>
	{/each}

	<div class="grid">
		<label class="field">
			<span>{m['time.fieldDate']()}</span>
			<input
				class="banto-input"
				type="date"
				bind:value={workDate}
				aria-invalid={!!errors.workDate}
			/>
			{#if errors.workDate}<span class="error">{errors.workDate}</span>{/if}
		</label>

		<fieldset class="field kind">
			<legend>{m['time.fieldTarget']()}</legend>
			<label
				><input type="radio" bind:group={kind} value="project" />{m['time.kindProject']()}</label
			>
			<label
				><input type="radio" bind:group={kind} value="activity" />{m['time.kindActivity']()}</label
			>
		</fieldset>

		{#if kind === 'project'}
			<label class="field">
				<span>{m['time.fieldProject']()}</span>
				<select class="banto-input" bind:value={projectId} aria-invalid={!!errors.projectId}>
					<option value="">{m['time.choose']()}</option>
					{#each projects as project (project.id)}
						<option value={String(project.id)}>{project.label}</option>
					{/each}
				</select>
				{#if errors.projectId}<span class="error">{errors.projectId}</span>{/if}
			</label>
			<label class="field">
				<span>{m['time.fieldPhase']()}</span>
				<select class="banto-input" bind:value={phaseId} aria-invalid={!!errors.phaseId}>
					<option value="">{m['time.choose']()}</option>
					{#each phaseChoices as phase (phase.id)}
						<option value={String(phase.id)}>{phase.name}</option>
					{/each}
				</select>
				{#if errors.phaseId}<span class="error">{errors.phaseId}</span>{/if}
			</label>
			<label class="field">
				<span>{m['time.fieldRework']()}</span>
				<select class="banto-input" bind:value={rework}>
					<option value="">{reworkLabel(null)}</option>
					{#each REWORK_KINDS as k (k)}
						<option value={k}>{reworkLabel(k)}</option>
					{/each}
				</select>
				{#if errors.reworkKind}<span class="error">{errors.reworkKind}</span>{/if}
			</label>
		{:else}
			<label class="field">
				<span>{m['time.fieldActivity']()}</span>
				<select class="banto-input" bind:value={activityId} aria-invalid={!!errors.activityId}>
					<option value="">{m['time.choose']()}</option>
					{#each activityChoices as activity (activity.id)}
						<option value={String(activity.id)}>{activity.name}</option>
					{/each}
				</select>
				{#if errors.activityId}<span class="error">{errors.activityId}</span>{/if}
			</label>
		{/if}

		<div class="field">
			<span id="time-hours-label">{m['time.fieldMinutes']()}</span>
			<div class="hm" role="group" aria-labelledby="time-hours-label">
				<input
					class="banto-input"
					type="number"
					min="0"
					max="24"
					step="1"
					inputmode="numeric"
					bind:value={hours}
					aria-label={m['time.hours']()}
					aria-invalid={!!errors.minutes}
				/>
				<span>{m['time.hoursSuffix']()}</span>
				<input
					class="banto-input"
					type="number"
					min="0"
					max="59"
					step="1"
					inputmode="numeric"
					bind:value={mins}
					aria-label={m['time.minutes']()}
					aria-invalid={!!errors.minutes}
				/>
				<span>{m['time.minutesSuffix']()}</span>
			</div>
			{#if errors.minutes}<span class="error">{errors.minutes}</span>{/if}
		</div>

		<label class="field wide">
			<span>{m['time.fieldDescription']()}</span>
			<textarea class="banto-input" rows="2" bind:value={description}></textarea>
			{#if errors.description}<span class="error">{errors.description}</span>{/if}
		</label>

		{#if correction}
			<label class="field wide">
				<span>{m['time.fieldCorrectionReason']()}</span>
				<textarea
					class="banto-input"
					rows="2"
					bind:value={reason}
					aria-invalid={!!errors.reason}
					required></textarea>
				{#if errors.reason}<span class="error">{errors.reason}</span>{/if}
			</label>
		{/if}
	</div>

	<div class="actions">
		<button type="submit" class="banto-btn banto-btn--primary" disabled={busy}>
			{correction
				? m['time.correctSubmit']()
				: start
					? m['time.saveChanges']()
					: m['time.saveDraft']()}
		</button>
		<button type="button" class="banto-btn banto-btn--ghost" disabled={busy} onclick={onCancel}>
			{m['common.cancel']()}
		</button>
	</div>
</form>

<style>
	.entry-form {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		border: 0;
		margin: 0;
		padding: 0;
	}

	.field input,
	.field select,
	.field textarea {
		color: var(--banto-text);
	}

	.field.wide {
		grid-column: 1 / -1;
	}

	.kind label {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		margin-right: var(--banto-space-3);
		color: var(--banto-text);
	}

	.hm {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
	}

	.hm input {
		width: 5rem;
	}

	.error {
		margin: 0;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.returned {
		margin: 0;
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-sm);
	}

	.actions {
		display: flex;
		gap: var(--banto-space-2);
	}
</style>
