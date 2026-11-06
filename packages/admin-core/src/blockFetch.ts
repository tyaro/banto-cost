/**
 * Pieces shared by the two block-fetching list resources
 * (`windowed.svelte.ts` and `snapshot.svelte.ts`, spec §4.1).
 *
 * Both record a failed block the same way (Issue #342 for
 * `SnapshotListResource`, Issue #344 for `WindowedListResource`): a
 * {@link ListBlockErrorFailure} with a {@link ListBlockFailureCode}, an error
 * that is either the data source's own `ProviderError` (the same object) or a
 * {@link ListBlockError}, texts the app can replace ({@link ListBlockMessages})
 * and a `notify` option. One error class and one code type serve both
 * resources, so an app tells the kinds apart with one `isListBlockError()` /
 * `code` check whichever resource recorded the failure, and a
 * `ListBlockError` a data source throws keeps its code in either.
 *
 * The failure types, `ListBlockError` / `isListBlockError` and
 * `defaultListBlockMessages` are exported from the package entry point; the
 * helpers below them are internal.
 */
import { isProviderError, ProviderError } from './errors';

/**
 * Why a block request failed:
 *
 * - `'request'`: the data source (the `DataProvider`'s `getList`, or the
 *   injected fetcher) threw or rejected,
 * - `'timeout'`: no answer within `requestTimeoutMs`,
 * - `'boundaryMismatch'`: `SnapshotListResource` only - the answer's
 *   `asOfId` is not the one sent,
 * - `'malformed'`: the answer cannot be written (not a list, a count that is
 *   not a valid array length, rows past the array-length limit, ...).
 */
export type ListBlockFailureCode = 'request' | 'timeout' | 'boundaryMismatch' | 'malformed';

/**
 * A failure a block resource creates itself: one it detected (`'timeout'`,
 * `'boundaryMismatch'`, `'malformed'`) or a data-source throw that was not a
 * `ProviderError` (`'request'`, the thrown value in `cause`). A
 * `ProviderError` the data source throws is recorded as is; a
 * `ListBlockError` it throws keeps its own code.
 */
export class ListBlockError extends ProviderError {
	readonly code: ListBlockFailureCode;

	constructor(code: ListBlockFailureCode, message: string, options: { cause?: unknown } = {}) {
		super({ kind: 'other', message });
		this.name = 'ListBlockError';
		this.code = code;
		if ('cause' in options) this.cause = options.cause;
	}
}

export function isListBlockError(error: unknown): error is ListBlockError {
	return error instanceof ListBlockError;
}

/** A block whose request failed; `code` says why (see {@link ListBlockFailureCode}). */
export interface ListBlockErrorFailure {
	readonly block: number;
	readonly kind: 'error';
	readonly code: ListBlockFailureCode;
	/**
	 * The data source's own `ProviderError` (the same object) for
	 * `'request'`, a {@link ListBlockError} otherwise.
	 */
	readonly error: ProviderError;
}

/**
 * Texts of the failures a block resource detects itself (i18n layer 1: the
 * app passes resolved strings, e.g. Paraglide message functions). Each is a
 * function, called when the failure is recorded, like the other `messages`
 * bundles of `@banto/*`. `SnapshotListMessages` adds `boundaryMismatch`.
 */
export interface ListBlockMessages {
	/** A request that did not answer within `ms` milliseconds. */
	timeout?: (ms: number) => string;
	/** An answer that cannot be written. */
	malformed?: () => string;
}

/** The English defaults of {@link ListBlockMessages}. */
export const defaultListBlockMessages: Required<ListBlockMessages> = {
	timeout: (ms) => `list request timed out after ${ms} ms`,
	malformed: () => 'malformed list result'
};

/** Default text of the `'boundaryMismatch'` failure (`SnapshotListResource`). */
export const DEFAULT_BOUNDARY_MISMATCH_MESSAGE = 'list snapshot boundary mismatch';

/**
 * The `notify` option of both resources: whether an `'error'` failure is also
 * reported through the registered notifier (a toast). `false` never; a
 * function decides per failure (one that throws counts as `false`).
 */
export type ListBlockNotify = boolean | ((failure: ListBlockErrorFailure) => boolean);

/** The largest valid JavaScript array length (2 ** 32 - 1). */
export const MAX_ARRAY_LENGTH = 0xffff_ffff;

/** A failure's code and the error recorded with it. */
export interface ListBlockErrorOutcome {
	code: ListBlockFailureCode;
	error: ProviderError;
}

/**
 * A data source's throw as a failure: a `ListBlockError` keeps its code, any
 * other `ProviderError` is `'request'` and kept as the same object, anything
 * else is wrapped in a `ListBlockError('request')` whose message is
 * `String(thrown)` and whose `cause` is the thrown value.
 */
export function requestFailure(thrown: unknown): ListBlockErrorOutcome {
	if (isListBlockError(thrown)) return { code: thrown.code, error: thrown };
	if (isProviderError(thrown)) return { code: 'request', error: thrown };
	return {
		code: 'request',
		error: new ListBlockError('request', String(thrown), { cause: thrown })
	};
}

/** Every text a detected failure may need (the Snapshot set is the widest). */
interface DetectedMessages extends ListBlockMessages {
	boundaryMismatch?: () => string;
}

const DETECTED_DEFAULTS: Required<DetectedMessages> = {
	...defaultListBlockMessages,
	boundaryMismatch: () => DEFAULT_BOUNDARY_MISMATCH_MESSAGE
};

/**
 * A failure the resource detected itself, with the app's text when it gave
 * one. Never throws: a message function that throws or returns a non-string
 * (app code) falls back to the default text, so a timeout still settles.
 */
export function detectedFailure(
	code: Exclude<ListBlockFailureCode, 'request'>,
	messages: DetectedMessages,
	ms = 0
): ListBlockErrorOutcome & { error: ListBlockError } {
	const text = (source: DetectedMessages): unknown =>
		code === 'timeout' ? source.timeout?.(ms) : source[code]?.();
	let message: unknown;
	try {
		message = text(messages);
	} catch {
		message = undefined;
	}
	if (typeof message !== 'string') message = text(DETECTED_DEFAULTS);
	return { code, error: new ListBlockError(code, message as string) };
}

/**
 * Whether an `'error'` failure goes to the notifier. A predicate is app code
 * and may throw: callers run this inside their own try/catch (a throw counts
 * as `false`).
 */
export function shouldNotify(option: ListBlockNotify, failure: ListBlockErrorFailure): boolean {
	return typeof option === 'function' ? option(failure) === true : option;
}

/** Whether `ms` enables a request time limit (`0`, a negative number, `NaN` or `Infinity` disable it). */
export function hasTimeLimit(ms: number): boolean {
	return ms > 0 && Number.isFinite(ms);
}

/**
 * Whether a list answer can be written at `offset` without throwing:
 * `rows` is an array, `totalCount` is a non-negative integer that is also a
 * valid array length (a safe integer is not enough - `2 ** 32` passes that
 * and then throws `RangeError` on `rows.length = ...`), and the rows written
 * at `offset` stay within that limit too.
 */
export function isWritableList(result: unknown, offset: number): boolean {
	if (result === null || typeof result !== 'object') return false;
	const { rows, totalCount } = result as { rows?: unknown; totalCount?: unknown };
	return (
		Array.isArray(rows) &&
		typeof totalCount === 'number' &&
		Number.isInteger(totalCount) &&
		totalCount >= 0 &&
		totalCount <= MAX_ARRAY_LENGTH &&
		offset + rows.length <= MAX_ARRAY_LENGTH
	);
}
