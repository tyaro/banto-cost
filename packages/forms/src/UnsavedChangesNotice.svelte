<script lang="ts">
	/**
	 * "Unsaved changes" marker (spec §7, issue #214): place it next to a
	 * save-type form's save button so the user can tell the draft has not
	 * been applied yet. Renders nothing while `pending` is false, so a clean
	 * form's layout is unchanged. The label is a resolved string from the
	 * host (i18n layer ①, conventions §13) - no default copy here.
	 */
	interface Props {
		/** Typically `guard.pending` or `store.isDirty`. */
		pending: boolean;
		label: string;
	}

	let { pending, label }: Props = $props();
</script>

{#if pending}
	<span class="banto-unsaved" role="status">{label}</span>
{/if}

<style>
	.banto-unsaved {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.15rem 0.55rem;
		border-radius: var(--banto-radius-sm);
		background: var(--banto-warning-tint);
		color: var(--banto-warning-tint-text);
		font-size: 0.8rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.banto-unsaved::before {
		content: '';
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--banto-warning);
	}
</style>
