/**
 * Runs one server action per row, one after another (review U-2: 一括承認,
 * 申請して承認). Bulk work only chains the existing per-row operations, so
 * each row is authorized, checked and audited exactly as when done by hand;
 * a refused row does not stop the rest. Returns how many succeeded, how many
 * failed and the first failure (its message tells the user why).
 */
export interface BulkResult {
	done: number;
	failed: number;
	firstError: unknown;
}

export async function runEach<T>(
	rows: readonly T[],
	action: (row: T) => Promise<unknown>
): Promise<BulkResult> {
	const result: BulkResult = { done: 0, failed: 0, firstError: null };
	for (const row of rows) {
		try {
			await action(row);
			result.done += 1;
		} catch (err) {
			if (result.failed === 0) result.firstError = err;
			result.failed += 1;
		}
	}
	return result;
}
