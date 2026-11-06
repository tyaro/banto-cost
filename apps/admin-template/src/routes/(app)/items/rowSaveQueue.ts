/**
 * Issue #284: per-row save serialization for inline edits and range pastes.
 *
 * Root cause being fixed: each save used to build the full editable value set
 * from a stale row snapshot (`edit.row`, taken when the edit started), so two
 * overlapping saves to the same row - e.g. paste into `name`, then paste into
 * `stock` before the first response lands - sent `{name: <old>, stock: new}`
 * and the later write reverted the earlier one.
 *
 * Fix: saves for one row id run strictly one after another (a Promise chain),
 * and the request body is composed at the moment of SENDING from the latest
 * confirmed row (the previous save's response) plus only this save's changed
 * columns. Different rows do not block each other.
 *
 * Failure semantics: a failed save rejects only its own caller; the chain
 * continues, and the failed values are never folded into the confirmed row, so
 * later saves are based on the last confirmed values. Results are produced in
 * send order (the chain guarantees it).
 *
 * The confirmed row for an id is dropped once its queue drains, so a later
 * edit is based on `currentRow` (the row as displayed at send time, already
 * updated with the saved result), falling back to the enqueue-time snapshot.
 */
export interface RowSaveQueueOptions<TRow> {
	/** Send one update. `values` is the full editable value set. */
	save: (rowId: string | number, values: Record<string, unknown>) => Promise<TRow>;
	/** Build the full value set from a base row + this save's changed columns. */
	compose: (base: TRow, changes: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Latest row as currently displayed, called at SEND time. Base priority:
	 * in-burst confirmed result -> currentRow(rowId) -> the enqueue-time
	 * fallbackRow (which may predate an earlier save that already drained).
	 */
	currentRow?: (rowId: string | number) => TRow | undefined;
}

export interface RowSaveQueue<TRow> {
	/**
	 * Queue `changes` for `rowId`. `fallbackRow` (the row as displayed when the
	 * edit started) is only used when no earlier save of this row has been
	 * confirmed within the current burst.
	 */
	enqueue(
		rowId: string | number,
		fallbackRow: TRow,
		changes: Record<string, unknown>
	): Promise<TRow>;
}

export function createRowSaveQueue<TRow>(options: RowSaveQueueOptions<TRow>): RowSaveQueue<TRow> {
	interface Lane {
		tail: Promise<unknown>;
		pending: number;
		confirmed: TRow | undefined;
	}
	const lanes = new Map<string | number, Lane>();

	return {
		enqueue(rowId, fallbackRow, changes) {
			const lane: Lane = lanes.get(rowId) ?? {
				tail: Promise.resolve(),
				pending: 0,
				confirmed: undefined
			};
			lanes.set(rowId, lane);
			lane.pending += 1;

			const run = async (): Promise<TRow> => {
				// Composed here, at send time - not when the edit was enqueued.
				const base = lane.confirmed ?? options.currentRow?.(rowId) ?? fallbackRow;
				const saved = await options.save(rowId, options.compose(base, changes));
				lane.confirmed = saved;
				return saved;
			};
			const result = lane.tail.then(run, run);
			const settle = (): void => {
				lane.pending -= 1;
				if (lane.pending === 0) lanes.delete(rowId);
			};
			lane.tail = result.then(settle, settle);
			return result;
		}
	};
}
