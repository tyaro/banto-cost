/**
 * i18n layer ② bridge (docs/conventions.md §13, ADR-0005, PR-B2): builds the
 * `messages` override bundles that the `@banto/*` packages accept (i18n layer
 * ①), sourcing every string from Paraglide (`#lib/paraglide/messages`).
 *
 * **App layer ONLY.** The packages stay i18n-agnostic: they declare a
 * `Partial<…Messages>` prop whose defaults reproduce today's Japanese output,
 * and the app hands them already-resolved strings here (conventions §4/§5 —
 * no `#lib` import or dictionary ever enters a package). Each entry is a thin
 * closure so the Paraglide message is resolved lazily at call time (render /
 * validation), keeping it reactive to the active locale.
 */
import type { GridMessages, ColumnValidationMessages } from '@banto/grid-svelte';
import type { ValidationMessages } from '@banto/forms';
import type { UiMessages } from '@banto/ui';
import * as m from '#lib/paraglide/messages.js';

/** @banto/grid-svelte `messages` prop: FilterPopover / HeaderCell / BantoGrid / ColumnsMenu strings. */
export function gridMessages(): Partial<GridMessages> {
	return {
		filterOpContains: () => m['grid.filterContains'](),
		filterOpStartsWith: () => m['grid.filterStartsWith'](),
		filterOpEquals: () => m['grid.filterEquals'](),
		filterAriaLabel: (header) => m['grid.filterAriaLabel']({ header }),
		filterAppliedDescription: (header) => m['grid.filterAppliedDescription']({ header }),
		filterOperatorLabel: () => m['grid.filterOperatorLabel'](),
		filterValueLabel: () => m['grid.filterValueLabel'](),
		filterValuePlaceholder: () => m['grid.filterValuePlaceholder'](),
		filterApply: () => m['grid.filterApply'](),
		filterClear: () => m['grid.filterClear'](),
		filterRangeLabel: () => m['grid.filterRangeLabel'](),
		filterRangeStart: () => m['grid.filterRangeStart'](),
		filterRangeEnd: () => m['grid.filterRangeEnd'](),
		filterRangeInvalid: () => m['grid.filterRangeInvalid'](),
		filterRangeOrder: () => m['grid.filterRangeOrder'](),
		inlineEditInvalid: () => m['grid.inlineEditInvalid'](),
		inlineEditErrorLabel: (header) => m['grid.inlineEditErrorLabel']({ header }),
		inlineEditErrorHint: () => m['grid.inlineEditErrorHint'](),
		emptyState: () => m['grid.emptyState'](),
		groupCountSuffix: (count) => m['grid.groupCountSuffix']({ count }),
		columnsMenuButton: () => m['grid.columnsMenuButton'](),
		columnsMenuTitle: () => m['grid.columnsMenuTitle'](),
		columnsMenuCount: (visible, total) => m['grid.columnsMenuCount']({ visible, total }),
		columnsMenuLastColumn: () => m['grid.columnsMenuLastColumn']()
	};
}

/** @banto/forms `ValidationMessages` (createFormStore): schema-form validation copy. */
export function formValidationMessages(): ValidationMessages {
	return {
		required: () => m['validation.required'](),
		min: (_def, min) => m['validation.min']({ min }),
		max: (_def, max) => m['validation.max']({ max }),
		minLength: (_def, min) => m['validation.minLength']({ min }),
		maxLength: (_def, max) => m['validation.maxLength']({ max }),
		pattern: () => m['validation.pattern'](),
		dateInvalid: () => m['validation.dateInvalid'](),
		dateMin: (_def, min) => m['validation.dateMin']({ min }),
		dateMax: (_def, max) => m['validation.dateMax']({ max }),
		dateDisabled: () => m['validation.dateDisabled'](),
		timeInvalid: () => m['validation.timeInvalid'](),
		timeMin: (_def, min) => m['validation.timeMin']({ min }),
		timeMax: (_def, max) => m['validation.timeMax']({ max }),
		timeStep: (_def, step) => m['validation.timeStep']({ step }),
		dateTimeInvalid: () => m['validation.dateTimeInvalid'](),
		dateTimeMin: (_def, min) => m['validation.dateTimeMin']({ min }),
		dateTimeMax: (_def, max) => m['validation.dateTimeMax']({ max })
	};
}

/** @banto/ui `DateInput` `messages` (date-time-pickers §5.5): the calendar's button / dialog / hint copy. */
export function dateInputMessages(): UiMessages {
	return {
		datePickerOpen: () => m['datePicker.open'](),
		datePickerChange: (date) => m['datePicker.change']({ date }),
		datePickerDialog: () => m['datePicker.dialog'](),
		datePickerPrevMonth: () => m['datePicker.prevMonth'](),
		datePickerNextMonth: () => m['datePicker.nextMonth'](),
		datePickerPrevYear: () => m['datePicker.prevYear'](),
		datePickerNextYear: () => m['datePicker.nextYear'](),
		datePickerToday: () => m['datePicker.today'](),
		datePickerClear: () => m['datePicker.clear'](),
		dateFormatHint: () => m['datePicker.formatHint']()
	};
}

/** @banto/ui `TimeInput` `messages` (date-time-pickers §5.5): the list button / list / hint copy. */
export function timeInputMessages(): UiMessages {
	return {
		timePickerOpen: () => m['timePicker.open'](),
		timePickerList: () => m['timePicker.list'](),
		timeFormatHint: () => m['timePicker.formatHint']()
	};
}

/** @banto/ui `DateTimeInput` `messages` (date-time-pickers §5.5, PR-5): the calendar's copy, the time list's and its own. */
export function dateTimeInputMessages(): UiMessages {
	return {
		...dateInputMessages(),
		timePickerList: () => m['timePicker.list'](),
		dateTimePickerOpen: () => m['dateTimePicker.open'](),
		dateTimePickerChange: (dateTime) => m['dateTimePicker.change']({ dateTime }),
		dateTimePickerDialog: () => m['dateTimePicker.dialog'](),
		dateTimeFormatHint: () => m['dateTimePicker.formatHint']()
	};
}

/** @banto/ui `DateRangeInput` `messages` (date-time-pickers §5.9, PR-6): both boxes' names plus the calendar's copy. */
export function dateRangeInputMessages(): UiMessages {
	return {
		...dateInputMessages(),
		dateRangeStart: () => m['dateRange.start'](),
		dateRangeEnd: () => m['dateRange.end']()
	};
}

/** @banto/grid-svelte `ColumnValidationMessages` (columnsFromSchema): inline-edit validation copy, kept in lockstep with {@link formValidationMessages}. */
export function columnValidationMessages(): ColumnValidationMessages {
	return {
		required: () => m['validation.required'](),
		min: (_field, min) => m['validation.min']({ min }),
		max: (_field, max) => m['validation.max']({ max }),
		minLength: (_field, min) => m['validation.minLength']({ min }),
		maxLength: (_field, max) => m['validation.maxLength']({ max }),
		pattern: () => m['validation.pattern'](),
		dateInvalid: () => m['validation.dateInvalid'](),
		dateMin: (_field, min) => m['validation.dateMin']({ min }),
		dateMax: (_field, max) => m['validation.dateMax']({ max }),
		dateDisabled: () => m['validation.dateDisabled'](),
		timeInvalid: () => m['validation.timeInvalid'](),
		timeMin: (_field, min) => m['validation.timeMin']({ min }),
		timeMax: (_field, max) => m['validation.timeMax']({ max }),
		timeStep: (_field, step) => m['validation.timeStep']({ step }),
		dateTimeInvalid: () => m['validation.dateTimeInvalid'](),
		dateTimeMin: (_field, min) => m['validation.dateTimeMin']({ min }),
		dateTimeMax: (_field, max) => m['validation.dateTimeMax']({ max })
	};
}
