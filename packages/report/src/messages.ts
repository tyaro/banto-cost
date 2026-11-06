/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/report's `ReportView.svelte`. Mirrors
 * @banto/grid-svelte's `messages.ts` convention - every message is a function
 * (parameterized ones take the relevant arguments, static ones take none) so
 * callers always call `t.key(...)` uniformly; `defaultReportMessages` holds
 * the current Japanese literals verbatim, so passing nothing reproduces
 * today's output exactly.
 */

export interface ReportMessages {
	/** Warnings `<summary>` text, given the warning count (as a string). */
	warningCount?: (count: string) => string;
	/** Print button label. */
	print?: () => string;
}

export const defaultReportMessages: Required<ReportMessages> = {
	warningCount: (count) => `警告 ${count}件`,
	print: () => '印刷'
};
