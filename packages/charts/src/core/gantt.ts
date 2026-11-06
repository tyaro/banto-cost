/**
 * Gantt-chart layout math (spec §6, roadmap.md M24). Pure number/time math:
 * turns a list of tasks with start/end instants into per-row fractional bar
 * geometry (0..1 across the time domain), with no knowledge of pixels, rows,
 * or SVG. `GanttChart.svelte` multiplies the fractions by the plot width and
 * assigns one row per task.
 *
 * Time is handled as epoch milliseconds throughout: `toMs` coerces
 * `number` (already ms) / `Date` / ISO-ish `string` into ms so callers can
 * pass whichever they have. Non-finite instants collapse to a zero-width bar
 * rather than throwing, mirroring the charts' "skip bad data, keep the slot"
 * convention (spec §6 rule 1).
 */

export interface GanttTask {
	/** Stable identifier; also the Svelte `#each` key. */
	id: string;
	label: string;
	/** Start instant: epoch ms, a `Date`, or a string `Date` can parse. */
	start: number | Date | string;
	/** End instant (same forms as `start`). Treated as start if earlier. */
	end: number | Date | string;
	/** Optional completion ratio 0..1; drives the progress overlay. */
	progress?: number;
	/**
	 * Optional 0-based color slot (into the theme series palette). Defaults to
	 * the task's row index so bars are distinguishable without extra config.
	 */
	colorIndex?: number;
}

/** Coerce a start/end value to epoch milliseconds; NaN for anything invalid. */
export function toMs(value: number | Date | string): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	return new Date(value).getTime();
}

/**
 * Overall [min start, max end] across all tasks, in ms. Tasks whose instants
 * are non-finite are ignored for the domain. Returns `null` when no task has
 * a usable start/end (caller renders the empty state).
 */
export function ganttDomain(tasks: GanttTask[]): [number, number] | null {
	let min = Infinity;
	let max = -Infinity;
	for (const t of tasks) {
		const s = toMs(t.start);
		const e = toMs(t.end);
		if (Number.isFinite(s)) min = Math.min(min, s);
		if (Number.isFinite(e)) max = Math.max(max, e);
		// A task with only one usable endpoint still bounds the domain by it.
		if (Number.isFinite(s)) max = Math.max(max, s);
		if (Number.isFinite(e)) min = Math.min(min, e);
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
	return [min, max];
}

export interface GanttBar {
	index: number;
	/** Left edge as a fraction 0..1 of the time domain (clamped). */
	startFrac: number;
	/** Bar width as a fraction 0..1 of the time domain (>= 0). */
	widthFrac: number;
	/** Progress width as a fraction of the *bar* (0..1); 0 when no progress. */
	progressFrac: number;
	colorIndex: number;
}

/**
 * Per-task bar geometry as fractions of `domain`. A zero-width domain (all
 * tasks at the same instant) maps every bar to `startFrac` 0 / `widthFrac` 0
 * so nothing divides by zero. `end` earlier than `start` is clamped to a
 * zero-width bar. `progress` is clamped to 0..1.
 */
export function ganttLayout(tasks: GanttTask[], domain: [number, number]): GanttBar[] {
	const [min, max] = domain;
	const span = max - min;
	return tasks.map((t, index) => {
		const s = toMs(t.start);
		const e = toMs(t.end);
		const startMs = Number.isFinite(s) ? s : min;
		const endMs = Number.isFinite(e) ? e : startMs;
		const clampedEnd = Math.max(startMs, endMs);
		const startFrac = span > 0 ? clamp01((startMs - min) / span) : 0;
		const endFrac = span > 0 ? clamp01((clampedEnd - min) / span) : 0;
		const widthFrac = Math.max(0, endFrac - startFrac);
		const progressFrac = Number.isFinite(t.progress ?? NaN) ? clamp01(t.progress as number) : 0;
		return {
			index,
			startFrac,
			widthFrac,
			progressFrac,
			colorIndex: t.colorIndex ?? index
		};
	});
}

function clamp01(n: number): number {
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}
