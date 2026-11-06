<script lang="ts">
	/**
	 * Report preview + print (docs/design/report-plan.md §3.3/§3.4/§3.5, unit B):
	 * runs `template`/`data` through the headless core (unit A's
	 * `renderReport`) and shows the result inside an A4-shaped paper preview,
	 * with a print button and a warnings disclosure above it.
	 *
	 * Consumers must also `import '@banto/report/print.css'` once (app-level,
	 * e.g. app.css) - this component only supplies the preview chrome
	 * (toolbar/paper shadow/`@page`), not the `.report-body` content rules.
	 */
	import { renderReport, type RenderOptions } from './core/index';
	import { defaultReportMessages, type ReportMessages } from './messages';

	interface Props {
		template: string;
		data: unknown;
		formatters?: RenderOptions['formatters'];
		title?: string;
		orientation?: 'portrait' | 'landscape';
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<ReportMessages>;
	}

	let {
		template,
		data,
		formatters,
		title,
		orientation = 'portrait',
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultReportMessages, ...messages };

	const result = $derived(renderReport(template, data, { formatters }));

	function handlePrint(): void {
		window.print();
	}

	// While `title` is set, it doubles as `document.title` (restored on
	// unmount): Chromium's print dialog / "Save as PDF" suggests the
	// document title as the output filename, so this turns `title="日報"`
	// into a sensibly-named PDF for free, not just an on-screen label.
	$effect(() => {
		if (!title) return;
		const previous = document.title;
		document.title = title;
		return () => {
			document.title = previous;
		};
	});

	// Design decision (docs/design/report-plan.md §3.4 "印刷時は帳票以外（シェル・
	// ボタン）を @media print で非表示"): this component's own toolbar is
	// hidden via a plain `@media print` rule in its scoped style block
	// below, but the app SHELL (sidebar/header, apps/admin-template's
	// (app)/+layout.svelte) lives outside this component entirely and has
	// no prop/slot channel ReportView could use to hide it directly.
	//
	// Rather than hard-coding a shell-specific selector into this
	// (app-agnostic) package, ReportView marks the document body element
	// with a plain presence flag class for exactly as long as it's
	// mounted. The HOST
	// app then opts in with a couple of `@media print` lines scoped to that
	// flag (see apps/admin-template/src/app.css) - only pages that actually
	// mount a ReportView ever have their shell hidden on print; every other
	// page's print output (e.g. printing a grid view directly) is
	// unaffected. This keeps the shell-hiding CSS in the app (where the
	// shell's markup/classes live) while keeping the trigger condition
	// (`ReportView is mounted`) owned by this package.
	$effect(() => {
		document.body.classList.add('banto-report-active');
		return () => {
			document.body.classList.remove('banto-report-active');
		};
	});
</script>

<!--
	`size: A4 landscape` below only applies when `orientation` is landscape;
	it then cascades AFTER the always-present base `@page` rule (this
	component's own top-level style block, below) in document order, so it
	wins. svelte:head itself must be a top-level tag (not nested inside a
	block) - only its CONTENTS are conditional here. Assumes at most one
	ReportView is mounted/printing at a time (true for this app's single
	report route) - a page with several independently-oriented reports
	would need a different mechanism.
-->
<svelte:head>
	{#if orientation === 'landscape'}
		<style>
			@page {
				size: A4 landscape;
			}
		</style>
	{/if}
</svelte:head>

<div class="report-view">
	<div class="toolbar">
		{#if title}
			<span class="title">{title}</span>
		{/if}
		<div class="toolbar-actions">
			{#if result.warnings.length > 0}
				<details class="warnings">
					<summary>{t.warningCount(String(result.warnings.length))}</summary>
					<ul>
						{#each result.warnings as warning (warning)}
							<li>{warning}</li>
						{/each}
					</ul>
				</details>
			{/if}
			<button type="button" class="print-btn" onclick={handlePrint}>{t.print()}</button>
		</div>
	</div>

	<div class="paper-wrap">
		<div class="paper" class:landscape={orientation === 'landscape'}>
			<!--
				`result.html` comes exclusively from this package's own
				renderReport (core/html.ts), which HTML-escapes every text value
				and attribute unconditionally - there is no "trusted" string
				anywhere in that module (see its own top comment). This is the
				only place that should ever bind this expression to
				renderReport()'s result; never widen this component to accept
				externally-supplied HTML.
			-->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html result.html}
		</div>
	</div>
</div>

<style>
	/* `@page` is not scoped by Svelte - at-rules with no selector body pass
	   through untouched, same as `@font-face` would. This is the base
	   portrait rule; the landscape override (when `orientation` is
	   'landscape') is injected separately via <svelte:head> above, since a
	   component's single <style> block can't itself be conditional. */
	@page {
		size: A4;
		margin: 12mm;
	}

	.report-view {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--banto-text);
	}

	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-left: auto;
	}

	.warnings {
		font-size: 0.8rem;
		color: var(--banto-warning-tint-text);
	}

	.warnings summary {
		cursor: pointer;
		font-weight: 600;
	}

	.warnings ul {
		margin: 0.4em 0 0;
		padding-left: 1.2em;
		max-width: 32rem;
	}

	.print-btn {
		height: var(--banto-control-height-sm);
		box-sizing: border-box;
		padding: 0 1rem;
		border: none;
		border-radius: var(--banto-radius-md);
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.print-btn:hover {
		background: var(--banto-primary-solid-hover);
	}

	/* Preview chrome only - outer area follows the active theme, the paper
	   itself stays white/shadowed regardless (report-plan §3.4: "外側だけがテーマに
	   従う"). The actual report content's own white background/black text
	   comes from `.report-body` in print.css; `.paper` just adds the
	   shadow + A4-shaped frame around it. */
	.paper-wrap {
		display: flex;
		justify-content: center;
		background: var(--banto-surface-subtle);
		border-radius: var(--banto-radius-lg);
		padding: 2rem 1rem;
	}

	.paper {
		width: 210mm;
		min-height: 297mm;
		max-width: 100%;
		background: #ffffff;
		box-shadow: var(--banto-shadow-md);
	}

	.paper.landscape {
		width: 297mm;
		min-height: 210mm;
	}

	@media print {
		.toolbar {
			display: none;
		}

		.paper-wrap {
			display: block;
			background: none;
			padding: 0;
		}

		.paper {
			width: auto;
			min-height: 0;
			max-width: none;
			box-shadow: none;
		}
	}
</style>
