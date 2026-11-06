/**
 * Public entry point for @banto/report (docs/design/report-plan.md, M19). Headless
 * template parser/binder/renderer (unit A) plus the preview/print UI (unit
 * B). Print CSS is a separate export (`@banto/report/print.css`, see
 * package.json `exports`) since it's plain CSS, not a JS module.
 */
export { renderReport, type RenderOptions, type RenderResult } from './core/index';
export { default as ReportView } from './ReportView.svelte';
export { defaultReportMessages, type ReportMessages } from './messages';
