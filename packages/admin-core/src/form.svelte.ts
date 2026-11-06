/**
 * `createFormResource` composable (spec §3.4): loads initial values for
 * create/edit, dispatches to `create`/`update` on submit, and surfaces
 * server-side field errors. Mirrors refine's `useForm`.
 */
import { isProviderError, ProviderError, type FieldError } from './errors';
import { invalidate } from './invalidate';
import { getDataProvider, notify } from './registry.svelte';

export type SubmitResult<T> = { ok: true; row: T } | { ok: false; fieldErrors: FieldError[] };

export class FormResource<T> {
	initialValues: Record<string, unknown> | null = $state(null);
	loading = $state(false);
	saving = $state(false);
	error: ProviderError | null = $state(null);

	#resource: string;
	#id: string | number | undefined;

	constructor(resource: string, id?: string | number) {
		this.#resource = resource;
		this.#id = id;
	}

	/** Load initial values: `getOne` when editing, `{}` when creating. */
	async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			this.initialValues =
				this.#id !== undefined
					? await getDataProvider().getOne<Record<string, unknown>>(this.#resource, this.#id)
					: {};
		} catch (err) {
			this.initialValues = null;
			this.error = isProviderError(err)
				? err
				: new ProviderError({ kind: 'other', message: String(err) });
		} finally {
			this.loading = false;
		}
	}

	/** create when constructed without an id, update otherwise. */
	async submit(values: Record<string, unknown>): Promise<SubmitResult<T>> {
		this.saving = true;
		try {
			const row =
				this.#id !== undefined
					? await getDataProvider().update<T>(this.#resource, this.#id, values)
					: await getDataProvider().create<T>(this.#resource, values);
			notify('success', '保存しました');
			invalidate(this.#resource);
			return { ok: true, row };
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				return { ok: false, fieldErrors: err.body.field_errors };
			}
			notify('error', isProviderError(err) ? err.message : String(err));
			return { ok: false, fieldErrors: [] };
		} finally {
			this.saving = false;
		}
	}

	/** Delete the current record. No-op (returns false) when there is no id. */
	async remove(): Promise<boolean> {
		if (this.#id === undefined) return false;
		try {
			await getDataProvider().deleteOne(this.#resource, this.#id);
			notify('success', '削除しました');
			invalidate(this.#resource);
			return true;
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
			return false;
		}
	}
}

export function createFormResource<T>(resource: string, id?: string | number): FormResource<T> {
	return new FormResource<T>(resource, id);
}
