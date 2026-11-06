<script lang="ts">
	/**
	 * Attachment panel for one resource record (spec `docs/design/attachments-plan.md`
	 * §3.7): thumbnail grid for images, a file-row list for everything else,
	 * upload (`canWrite` only), and delete (`canWrite` only, confirmed).
	 * Loading/empty/error states are owned entirely inside this component
	 * (existing ownership-boundary rule already followed by
	 * `@banto/grid-svelte`'s internal empty/error states) - the host page
	 * never has to branch on attachment-loading state itself.
	 *
	 * Transport is fully injected via `client: AttachmentsClient` - this file
	 * has no app-specific import (no `sessionStore`, no `@banto/admin-core`
	 * `ProviderError`; see `core/errors.ts`). The app wires a concrete
	 * client from `attachmentsAdmin.ts`.
	 */
	import { untrack } from 'svelte';
	import type { AttachmentMeta, AttachmentsClient } from './types';
	import { formatFileSize } from './core/format';
	import { fileTypeLabel } from './core/fileType';
	import { errorMessage } from './core/errors';
	import { fetchAttachmentList, partitionByThumbnail } from './core/list';
	import { defaultAttachmentsMessages, type AttachmentsMessages } from './messages';

	interface Props {
		client: AttachmentsClient;
		resource: string;
		resourceId: string;
		canWrite: boolean;
		title?: string;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<AttachmentsMessages>;
	}

	let {
		client,
		resource,
		resourceId,
		canWrite,
		title = '添付ファイル',
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultAttachmentsMessages, ...messages };

	let items = $state<AttachmentMeta[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	/** Object URLs for `hasThumbnail` items that resolved successfully - keyed by attachment id. Caller (this component) owns revoking every entry (attachments-plan §3.7). */
	let thumbnails = $state<Map<number, string>>(new Map());

	let uploading = $state(false);
	let uploadError = $state<string | null>(null);
	let deletingId = $state<number | null>(null);
	let downloadingId = $state<number | null>(null);
	/** Surfaced separately from `error` so a failed delete/download doesn't blank out the currently-rendered list. */
	let actionError = $state<string | null>(null);

	let fileInput: HTMLInputElement | undefined = $state();

	const grouped = $derived(partitionByThumbnail(items));

	// Bumped on every reload() and on effect teardown; lets an in-flight
	// request that got superseded (resource/resourceId changed, or a second
	// reload was triggered before the first settled) detect it should
	// discard its result instead of clobbering newer state - and, for
	// thumbnails specifically, revoke the object URLs it fetched but never
	// displayed.
	let loadToken = 0;

	function clearThumbnails(): void {
		for (const url of thumbnails.values()) URL.revokeObjectURL(url);
		thumbnails = new Map();
	}

	async function loadThumbnails(list: AttachmentMeta[], token: number): Promise<void> {
		const targets = list.filter((item) => item.hasThumbnail);
		if (targets.length === 0) return;
		const resolved = await Promise.all(
			targets.map(async (item) => {
				try {
					const url = await client.thumbnailUrl(item);
					return [item.id, url] as const;
				} catch {
					// One bad thumbnail (e.g. a stale backup restore, attachments-plan §8's
					// known limitation) shouldn't break the rest of the grid - it
					// just falls back to the type-badge tile below.
					return null;
				}
			})
		);
		if (token !== loadToken) {
			for (const entry of resolved) if (entry) URL.revokeObjectURL(entry[1]);
			return;
		}
		const map = new Map<number, string>();
		for (const entry of resolved) if (entry) map.set(entry[0], entry[1]);
		thumbnails = map;
	}

	async function reload(targetResource: string, targetResourceId: string): Promise<void> {
		const token = ++loadToken;
		loading = true;
		error = null;
		actionError = null;
		clearThumbnails();

		const outcome = await fetchAttachmentList(client, targetResource, targetResourceId);
		if (token !== loadToken) return;

		if (outcome.status === 'ok') {
			items = outcome.items;
			loading = false;
			await loadThumbnails(outcome.items, token);
		} else {
			items = [];
			error = outcome.message;
			loading = false;
		}
	}

	function retry(): void {
		void reload(resource, resourceId);
	}

	$effect(() => {
		// Re-run on mount and whenever resource/resourceId change (attachments-plan §3.7).
		// These two reads are the effect's ONLY intended dependencies.
		const targetResource = resource;
		const targetResourceId = resourceId;
		// untrack: reload()'s synchronous prefix (everything before its first
		// await) otherwise runs inside this effect's tracking context, and
		// clearThumbnails() both READS `thumbnails` (registering it as a
		// dependency) and WRITES it - the effect would then re-trigger itself
		// forever (effect_update_depth_exceeded, hammering list requests;
		// caught by smoke scenario 8, which lingers on the panel where the
		// pre-existing scenarios navigated away too fast to crash).
		untrack(() => void reload(targetResource, targetResourceId));
		return () => {
			loadToken++;
			clearThumbnails();
		};
	});

	function triggerUpload(): void {
		fileInput?.click();
	}

	async function handleFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file later
		if (!file) return;

		uploading = true;
		uploadError = null;
		try {
			await client.upload(resource, resourceId, file);
			await reload(resource, resourceId);
		} catch (err) {
			uploadError = errorMessage(err, { unknown: t.unknownError });
		} finally {
			uploading = false;
		}
	}

	async function handleDelete(item: AttachmentMeta): Promise<void> {
		if (!window.confirm(t.deleteConfirm(item.fileName))) return;
		deletingId = item.id;
		actionError = null;
		try {
			await client.remove(item.id);
			await reload(resource, resourceId);
		} catch (err) {
			actionError = errorMessage(err, { unknown: t.unknownError });
		} finally {
			deletingId = null;
		}
	}

	async function handleDownload(item: AttachmentMeta): Promise<void> {
		downloadingId = item.id;
		actionError = null;
		try {
			const url = await client.downloadUrl(item);
			try {
				const a = document.createElement('a');
				a.href = url;
				a.download = item.fileName;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
			} finally {
				URL.revokeObjectURL(url);
			}
		} catch (err) {
			actionError = errorMessage(err, { unknown: t.unknownError });
		} finally {
			downloadingId = null;
		}
	}
</script>

<section class="panel">
	<header class="header">
		<h2>{title}</h2>
		{#if canWrite}
			<div class="upload">
				<button type="button" onclick={triggerUpload} disabled={uploading}>
					{uploading ? t.uploading() : t.upload()}
				</button>
				<input
					class="file-input"
					type="file"
					bind:this={fileInput}
					onchange={handleFileChange}
					disabled={uploading}
					aria-label={t.uploadAriaLabel(title)}
				/>
			</div>
		{/if}
	</header>

	{#if uploadError}
		<p class="message message--error" role="alert">{uploadError}</p>
	{/if}
	{#if actionError}
		<p class="message message--error" role="alert">{actionError}</p>
	{/if}

	{#if loading}
		<p class="message" role="status" aria-live="polite">{t.loading()}</p>
	{:else if error}
		<div class="message message--error" role="alert">
			<p>{error}</p>
			<button type="button" onclick={retry}>{t.retry()}</button>
		</div>
	{:else if items.length === 0}
		<p class="message">{t.empty()}</p>
	{:else}
		{#if grouped.withThumbnail.length > 0}
			<ul class="thumb-grid">
				{#each grouped.withThumbnail as item (item.id)}
					<li class="thumb-tile">
						<button
							type="button"
							class="thumb-button"
							onclick={() => void handleDownload(item)}
							disabled={downloadingId === item.id}
							title={item.fileName}
						>
							{#if thumbnails.get(item.id)}
								<img src={thumbnails.get(item.id)} alt={item.fileName} />
							{:else}
								<span class="thumb-fallback">{fileTypeLabel(item.fileName)}</span>
							{/if}
						</button>
						<span class="file-name">{item.fileName}</span>
						<span class="file-size">{formatFileSize(item.sizeBytes)}</span>
						{#if canWrite}
							<button
								type="button"
								class="delete-btn"
								onclick={() => void handleDelete(item)}
								disabled={deletingId === item.id}
							>
								{t.remove()}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if grouped.withoutThumbnail.length > 0}
			<ul class="file-list">
				{#each grouped.withoutThumbnail as item (item.id)}
					<li class="file-row">
						<span class="badge">{fileTypeLabel(item.fileName)}</span>
						<span class="file-name">{item.fileName}</span>
						<span class="file-size">{formatFileSize(item.sizeBytes)}</span>
						<button
							type="button"
							onclick={() => void handleDownload(item)}
							disabled={downloadingId === item.id}
						>
							{t.download()}
						</button>
						{#if canWrite}
							<button
								type="button"
								class="delete-btn"
								onclick={() => void handleDelete(item)}
								disabled={deletingId === item.id}
							>
								{t.remove()}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: 1.25rem;
		/* Standard preset: no-op (var(--banto-backdrop) is `none`); glass
		   preset opts in by overriding it (spec §9), same as the card this
		   panel visually matches. */
		backdrop-filter: var(--banto-backdrop, none);
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	h2 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--banto-text);
	}

	.upload {
		position: relative;
	}

	.file-input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: pointer;
	}

	.file-input:disabled {
		cursor: not-allowed;
	}

	button {
		height: var(--banto-control-height-sm);
		box-sizing: border-box;
		padding: 0 0.9rem;
		border: none;
		border-radius: var(--banto-radius-md);
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	button:hover:not(:disabled) {
		background: var(--banto-primary-solid-hover);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.file-list button:not(.delete-btn) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.delete-btn {
		background: var(--banto-danger-tint);
		color: var(--banto-danger-tint-text);
	}

	.delete-btn:hover:not(:disabled) {
		background: var(--banto-danger-solid);
		color: var(--banto-on-solid);
	}

	.message {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.85rem;
		color: var(--banto-text-muted);
	}

	.message--error {
		color: var(--banto-danger-tint-text);
	}

	.thumb-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.thumb-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
	}

	.thumb-button {
		width: 100%;
		aspect-ratio: 1;
		padding: 0;
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-subtle);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.thumb-button img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.thumb-fallback {
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: var(--banto-text-muted);
	}

	.file-list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.file-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.badge {
		flex: none;
		padding: 0.15rem 0.4rem;
		border-radius: var(--banto-radius-sm);
		background: var(--banto-surface-subtle);
		color: var(--banto-text-muted);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.03em;
	}

	.file-name {
		font-size: 0.8rem;
		color: var(--banto-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.thumb-tile .file-name {
		max-width: 104px;
	}

	.file-row .file-name {
		flex: 1;
	}

	.file-size {
		flex: none;
		font-size: 0.7rem;
		color: var(--banto-text-muted);
	}
</style>
