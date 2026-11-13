/**
 * Display and date helpers of the time-entry screens (工数, spec §6.1, P4b).
 * Minutes are integers and are shown as `h:mm`; weeks start on Monday.
 * Labels resolve through Paraglide at call time (conventions §13), so call
 * the label helpers from render code, not at module load.
 */
import * as m from '#lib/paraglide/messages.js';
import type { ReworkKind, TimeStatus, TimeWarning } from './timeAdmin';

/** `450` -> `7:30`. Negative values keep their sign. */
export function formatMinutes(minutes: number): string {
	const sign = minutes < 0 ? '-' : '';
	const abs = Math.abs(minutes);
	return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

/** Hours and minutes typed separately -> minutes, or `null` when not whole non-negative numbers. */
export function toMinutes(hours: string | number, minutes: string | number): number | null {
	const h = Number(hours === '' ? 0 : hours);
	const mm = Number(minutes === '' ? 0 : minutes);
	if (!Number.isInteger(h) || !Number.isInteger(mm) || h < 0 || mm < 0) return null;
	return h * 60 + mm;
}

function parseIso(iso: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!match) return null;
	const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	return d.getUTCMonth() === Number(match[2]) - 1 ? d : null;
}

function toIso(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** `iso` + `days` (UTC arithmetic, so no time-zone drift). Invalid input comes back unchanged. */
export function addDays(iso: string, days: number): string {
	const d = parseIso(iso);
	if (!d) return iso;
	d.setUTCDate(d.getUTCDate() + days);
	return toIso(d);
}

/** The Monday of the week that contains `iso`. */
export function mondayOf(iso: string): string {
	const d = parseIso(iso);
	if (!d) return iso;
	const back = (d.getUTCDay() + 6) % 7;
	return addDays(iso, -back);
}

/** The seven dates from `monday`. */
export function weekDates(monday: string): string[] {
	return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Day-of-week index of a date, Monday = 0. */
export function weekdayIndex(iso: string): number {
	const d = parseIso(iso);
	return d ? (d.getUTCDay() + 6) % 7 : 0;
}

const WEEKDAYS: (() => string)[] = [
	() => m['time.weekday.mon'](),
	() => m['time.weekday.tue'](),
	() => m['time.weekday.wed'](),
	() => m['time.weekday.thu'](),
	() => m['time.weekday.fri'](),
	() => m['time.weekday.sat'](),
	() => m['time.weekday.sun']()
];

/** `2026-11-09` -> `11/9（月）`. */
export function dayLabel(iso: string): string {
	const d = parseIso(iso);
	if (!d) return iso;
	return m['time.dayLabel']({
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		weekday: WEEKDAYS[weekdayIndex(iso)]()
	});
}

const STATUS: Record<TimeStatus, () => string> = {
	draft: () => m['time.status.draft'](),
	submitted: () => m['time.status.submitted'](),
	approved: () => m['time.status.approved'](),
	returned: () => m['time.status.returned']()
};

export function timeStatusLabel(status: string): string {
	return STATUS[status as TimeStatus]?.() ?? status;
}

/** Badge variant of a status (StatusBadge). */
export function timeStatusVariant(
	status: string
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
	switch (status) {
		case 'submitted':
			return 'info';
		case 'approved':
			return 'success';
		case 'returned':
			return 'warning';
		default:
			return 'neutral';
	}
}

const REWORK: Record<ReworkKind, () => string> = {
	internal: () => m['time.rework.internal'](),
	customer: () => m['time.rework.customer'](),
	other: () => m['time.rework.other']()
};

export const REWORK_KINDS: readonly ReworkKind[] = ['internal', 'customer', 'other'];

/** Rework label; `null` is the original work (当初作業). */
export function reworkLabel(kind: string | null): string {
	if (!kind) return m['time.rework.none']();
	return REWORK[kind as ReworkKind]?.() ?? kind;
}

/** A save warning as one sentence. */
export function warningText(w: TimeWarning): string {
	if (w.code === 'duplicate') return m['time.warning.duplicate']({ count: w.ids.length });
	return m['time.warning.dayStandard']({
		total: formatMinutes(w.total),
		standard: formatMinutes(w.standard)
	});
}

/**
 * What a confirmation dialog shows to identify one time entry (review §8-8,
 * PR #46): who, the work date, the project or common activity, and the hours.
 */
export function timeEntryDetails(e: {
	userName: string;
	workDate: string;
	projectCode: string | null;
	projectName: string | null;
	activityName: string | null;
	minutes: number;
}): { label: string; value: string }[] {
	const target =
		e.projectCode !== null
			? `${e.projectCode} ${e.projectName ?? ''}`.trim()
			: (e.activityName ?? '');
	return [
		{ label: m['approvals.colPerson'](), value: e.userName },
		{ label: m['time.colDate'](), value: e.workDate },
		{ label: m['time.colTarget'](), value: target },
		{ label: m['time.colMinutes'](), value: formatMinutes(e.minutes) }
	];
}
