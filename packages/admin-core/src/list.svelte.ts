/**
 * `createListResource` composable (spec §3.4): reactive list state wired to
 * the registered DataProvider, auto-reloading when the resource is
 * invalidated. Mirrors refine's `useTable`.
 *
 * Runes constraint: this class never creates an `$effect` itself (no effect
 * context in a plain module); components wire `$effect`/cleanup around
 * `load()`/`dispose()`.
 */
import { isProviderError, ProviderError } from './errors';
import { onInvalidate } from './invalidate';
import { getDataProvider, notify } from './registry.svelte';
import { createRequestOwner } from './request.svelte';
import type { ListParams } from './types';

export interface CreateListResourceOptions {
	initialParams?: Partial<ListParams>;
}

export class ListResource<T> {
	rows: T[] = $state([]);
	totalCount = $state(0);
	loading = $state(false);
	error: ProviderError | null = $state(null);
	params: ListParams = $state({ sort: [], filters: [] });

	#resource: string;
	#unsubscribe: () => void;
	// Out-of-order responses (known race, M5): two rapid invalidates each start
	// a `load()`; a slow-resolving earlier call must not overwrite
	// rows/totalCount/error written by a faster *later* call, nor clear its
	// `loading`. The request owner (request.svelte.ts, Issue #436) answers
	// "is this still the latest load?". `dispose()` deliberately does not
	// dispose it, so an in-flight load still lands exactly as before.
	#requests = createRequestOwner();

	constructor(resource: string, options: CreateListResourceOptions = {}) {
		this.#resource = resource;
		this.params = { sort: [], filters: [], ...options.initialParams };
		this.#unsubscribe = onInvalidate(resource, () => {
			void this.load();
		});
	}

	/** Fetch rows for the current `params`. Does not auto-run; call once from the component. */
	async load(): Promise<void> {
		const request = this.#requests.begin();
		this.loading = true;
		this.error = null;
		try {
			const result = await getDataProvider().getList<T>(this.#resource, this.params);
			if (!request.isCurrent()) return; // a newer load() already superseded this one
			this.rows = result.rows;
			this.totalCount = result.totalCount;
		} catch (err) {
			if (!request.isCurrent()) return;
			const providerError = isProviderError(err)
				? err
				: new ProviderError({ kind: 'other', message: String(err) });
			this.error = providerError;
			notify('error', providerError.message);
		} finally {
			if (request.finish()) this.loading = false;
		}
	}

	/** Stop reacting to invalidate() calls for this resource. Call from the owning component's cleanup. */
	dispose(): void {
		this.#unsubscribe();
	}
}

export function createListResource<T>(
	resource: string,
	options?: CreateListResourceOptions
): ListResource<T> {
	return new ListResource<T>(resource, options);
}
