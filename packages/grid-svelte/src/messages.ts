/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/grid-svelte's Svelte components (FilterPopover,
 * HeaderCell, BantoGrid). Mirrors @banto/forms' `validate.ts` convention -
 * every message is a function (parameterized ones take the relevant
 * arguments, static ones take none) so callers always call `t.key(...)`
 * uniformly; `defaultGridMessages` holds the current Japanese literals
 * verbatim, so passing nothing reproduces today's output exactly.
 */

export interface GridMessages {
	/** FilterPopover's TEXT_OPS 'contains' operator label. */
	filterOpContains?: () => string;
	/** FilterPopover's TEXT_OPS 'starts_with' operator label. */
	filterOpStartsWith?: () => string;
	/** FilterPopover's TEXT_OPS 'eq' operator label. */
	filterOpEquals?: () => string;
	/** Filter button/popover aria-label (HeaderCell + FilterPopover), given the column's header text. */
	filterAriaLabel?: (header: string) => string;
	/** Applied-filter state description, independent of the popover's open state. */
	filterAppliedDescription?: (header: string) => string;
	/** FilterPopover's value input placeholder. */
	filterValuePlaceholder?: () => string;
	/** Accessible name of FilterPopover's operator select. */
	filterOperatorLabel?: () => string;
	/** Accessible name of FilterPopover's value input. */
	filterValueLabel?: () => string;
	/** FilterPopover's apply button label. */
	filterApply?: () => string;
	/** FilterPopover's clear button label. */
	filterClear?: () => string;
	/** FilterPopover: accessible name of the day range of a date / date-and-time column. */
	filterRangeLabel?: () => string;
	/** FilterPopover: the native start-day input's name (the injected `DateRangeInput` names its own). */
	filterRangeStart?: () => string;
	/** FilterPopover: the native end-day input's name. */
	filterRangeEnd?: () => string;
	/** FilterPopover: a range end is not a date. */
	filterRangeInvalid?: () => string;
	/** FilterPopover: the end day is before the start day. */
	filterRangeOrder?: () => string;
	/** BantoGrid inline-edit error shown when parseCellInput rejects the draft value. */
	inlineEditInvalid?: () => string;
	/** Name of the keyboard-readable error region for a column. */
	inlineEditErrorLabel?: (header: string) => string;
	/** Explains reading an error without retrying the save. */
	inlineEditErrorHint?: () => string;
	/** BantoGrid's empty-state message when there are zero rows. */
	emptyState?: () => string;
	/** BantoGrid group header's row-count suffix, given the already-`toLocaleString()`-ed count. */
	groupCountSuffix?: (count: string) => string;
	/** ColumnsMenu's trigger button label (spec §4.4). */
	columnsMenuButton?: () => string;
	/** ColumnsMenu's popover aria-label (spec §4.4). */
	columnsMenuTitle?: () => string;
	/** ColumnsMenu's visible/total counter next to the trigger label, given both counts. */
	columnsMenuCount?: (visible: number, total: number) => string;
	/** ColumnsMenu's tooltip on the last remaining visible column's (disabled) checkbox. */
	columnsMenuLastColumn?: () => string;
}

export const defaultGridMessages: Required<GridMessages> = {
	filterOpContains: () => '含む',
	filterOpStartsWith: () => 'で始まる',
	filterOpEquals: () => '一致する',
	filterAriaLabel: (header) => `${header}の絞り込み`,
	filterAppliedDescription: (header) => `${header}の絞り込みを適用中`,
	filterValuePlaceholder: () => '値を入力',
	filterOperatorLabel: () => '絞り込み条件',
	filterValueLabel: () => '絞り込み値',
	filterApply: () => '適用',
	filterClear: () => 'クリア',
	filterRangeLabel: () => '期間',
	filterRangeStart: () => '開始日',
	filterRangeEnd: () => '終了日',
	filterRangeInvalid: () => '日付は YYYY-MM-DD の形で入力してください',
	filterRangeOrder: () => '終了日は開始日と同じ日かそれより後にしてください',
	inlineEditInvalid: () => '入力値が不正です',
	inlineEditErrorLabel: (header) => `${header}のエラー`,
	inlineEditErrorHint: () =>
		'入力欄ではTabでエラーを確認、Enterで再試行。エラー欄ではShift+TabまたはEscapeで入力欄に戻ります。',
	emptyState: () => 'データがありません',
	groupCountSuffix: (count) => `（${count}件）`,
	columnsMenuButton: () => '列',
	columnsMenuTitle: () => '列の表示',
	columnsMenuCount: (visible, total) => `${visible}/${total}`,
	columnsMenuLastColumn: () => '最後の1列は非表示にできません'
};
