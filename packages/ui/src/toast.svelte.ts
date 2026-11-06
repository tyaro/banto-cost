/**
 * Toast store (ADR-0018 §8, phase 2c; owner decision 9). Svelte 5 runes, so
 * this is a `.svelte.ts` source: consumers must list `@banto/ui` in Vite's
 * `optimizeDeps.exclude` (ADR-0007, docs/conventions.md §14).
 *
 * One store shared by admin-template, ChronoGazer and banto-hub: the three
 * copies differed only in banto-hub's action button (e.g. "undo") and its
 * `id` return value, both of which are standard here. The app keeps only the
 * wiring from admin-core's `Notifier` to the store:
 *
 *     export const toastStore = createToastStore();
 *     const notifier = { notify: (kind, message) => toastStore.push(kind, message) };
 *
 * `ToastKind` is structurally the same union as admin-core's
 * `NotificationKind` (this package imports nothing but `svelte`).
 */

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
	/** The action button's text. */
	label: string;
	/** Runs on click; the toast is dismissed afterwards even if this throws (the error propagates). */
	onAction: () => void;
}

export interface Toast {
	id: string;
	kind: ToastKind;
	message: string;
	/** Already wrapped by the store: calling `onAction` runs the caller's handler, then dismisses the toast. */
	action?: ToastAction;
}

export interface ToastPushOptions {
	/** Adds an action button (e.g. an undo). */
	action?: ToastAction;
	/** Milliseconds until the toast dismisses itself. Default: the store's `autoDismissMs` (4000). `0`, a negative number or `Infinity`: stays until dismissed. */
	durationMs?: number;
	/** Identifies the toast. Pushing an id that is already shown replaces that toast in place (and restarts its timer). Explicit ids are for intentional replacement. Default: a generated id (`toast-N`), unique among the toasts currently shown (it never collides with a caller's id). */
	id?: string;
}

export interface ToastStoreOptions {
	/** Default `durationMs` for toasts that do not set one. Default 4000. */
	autoDismissMs?: number;
	/** Most toasts shown at once; pushing past it dismisses the oldest. Default: no limit. */
	maxToasts?: number;
}

export interface ToastStore {
	readonly toasts: readonly Toast[];
	/** Shows a toast and returns its id (usable with `dismiss`). */
	push(kind: ToastKind, message: string, options?: ToastPushOptions): string;
	/** Removes a toast and cancels its timer. Unknown ids are ignored. */
	dismiss(id: string): void;
}

export const DEFAULT_TOAST_DURATION_MS = 4000;

class ToastStoreImpl implements ToastStore {
	toasts: Toast[] = $state([]);
	#nextId = 1;
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** id -> generation token of the instance currently shown (internal; a replacement or re-push of the same id gets a new token). */
	#live = new Map<string, symbol>();
	#autoDismissMs: number;
	#maxToasts: number;

	constructor(options: ToastStoreOptions = {}) {
		this.#autoDismissMs = options.autoDismissMs ?? DEFAULT_TOAST_DURATION_MS;
		this.#maxToasts = options.maxToasts !== undefined ? Math.max(1, options.maxToasts) : Infinity;
	}

	push(kind: ToastKind, message: string, options?: ToastPushOptions): string {
		const id = options?.id ?? this.#generateId();
		const source = options?.action;
		const token = Symbol(id);
		const action: ToastAction | undefined = source
			? {
					label: source.label,
					onAction: () => {
						// Dismissed or replaced since this instance was pushed (timer, a
						// fast second click, a stale reference after id reuse): the
						// handler must not run, and must not touch the newer toast.
						if (this.#live.get(id) !== token) return;
						try {
							source.onAction();
						} finally {
							// Only this instance: a handler that re-pushed the same id
							// keeps its updated toast.
							this.#dismissInstance(id, token);
						}
					}
				}
			: undefined;
		const toast: Toast = { id, kind, message, action };

		this.#clearTimer(id);
		this.#live.set(id, token);
		const index = this.toasts.findIndex((t) => t.id === id);
		if (index >= 0) {
			this.toasts = this.toasts.map((t, i) => (i === index ? toast : t));
		} else {
			this.toasts = [...this.toasts, toast];
			while (this.toasts.length > this.#maxToasts) this.dismiss(this.toasts[0].id);
		}

		const duration = options?.durationMs ?? this.#autoDismissMs;
		if (duration > 0 && Number.isFinite(duration)) {
			this.#timers.set(
				id,
				setTimeout(() => this.#dismissInstance(id, token), duration)
			);
		}
		return id;
	}

	dismiss(id: string): void {
		this.#clearTimer(id);
		this.#live.delete(id);
		this.toasts = this.toasts.filter((toast) => toast.id !== id);
	}

	/** Dismisses `id` only if the instance identified by `token` is still the one shown. */
	#dismissInstance(id: string, token: symbol): void {
		if (this.#live.get(id) === token) this.dismiss(id);
	}

	/** `toast-N`, skipping any id a caller already put on screen so a generated id never replaces a toast. */
	#generateId(): string {
		let id: string;
		do {
			id = `toast-${this.#nextId++}`;
		} while (this.toasts.some((toast) => toast.id === id));
		return id;
	}

	#clearTimer(id: string): void {
		const timer = this.#timers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(id);
		}
	}
}

export function createToastStore(options?: ToastStoreOptions): ToastStore {
	return new ToastStoreImpl(options);
}
