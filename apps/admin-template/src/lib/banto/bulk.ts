/**
 * Runs one server action per row, one after another (review U-2: 一括承認,
 * 申請して承認). Bulk work only chains the existing per-row operations, so
 * each row is authorized, checked and audited exactly as when done by hand;
 * a refused row does not stop the rest. Returns how many succeeded, how many
 * failed and the first failure (its message tells the user why).
 */
import { isProviderError } from '@banto/admin-core';
import { isForbiddenError } from './costFormat.js';

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

/**
 * Why a bulk row was refused, for the message: `forbidden` as the screen's
 * own wording, a validation refusal as its field messages (the useful part,
 * e.g. a closed month), otherwise the error's message.
 */
export function failureReason(err: unknown, forbidden: string): string {
	if (isForbiddenError(err)) return forbidden;
	if (isProviderError(err)) {
		if (err.body.kind === 'validation' && err.body.field_errors.length > 0) {
			return err.body.field_errors.map((e) => e.message).join(' / ');
		}
		return err.message;
	}
	return String(err);
}
