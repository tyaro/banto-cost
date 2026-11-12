/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/ui. Same convention as `defaultGridMessages` in
 * @banto/grid-svelte - every message is a function so callers always call
 * `t.key(...)` uniformly; `defaultUiMessages` holds the Japanese literal
 * verbatim, so passing nothing reproduces the stock output.
 *
 * Components with their own text take `messages?: UiMessages` and merge it
 * over the defaults (CommandPalette, ToastHost, Modal, Drawer, DateInput, TimeInput, DateTimeInput, DateRangeInput). Apps that localise (admin-template
 * does, via Paraglide) pass their own text explicitly - see `LoadingState`'s
 * `label` and admin-template's CommandPalette wrapper.
 */

export interface UiMessages {
	/** LoadingState's screen-reader announcement when no `label` is given. */
	loading?: () => string;
	/** CommandPalette: the dialog's accessible name. */
	commandPaletteLabel?: () => string;
	/** CommandPalette: the search input's placeholder. */
	commandPalettePlaceholder?: () => string;
	/** CommandPalette: the result list's accessible name. */
	commandPaletteListLabel?: () => string;
	/** CommandPalette: shown when nothing matches. */
	commandPaletteEmpty?: () => string;
	/** CommandPalette: heading of the recent section (`recentIds`). */
	commandPaletteRecent?: () => string;
	/** ToastHost: the close button's accessible name. */
	toastClose?: () => string;
	/** Modal / Drawer: the close (×) button's accessible name and tooltip. */
	overlayClose?: () => string;
	/** DateInput: the calendar button's name while there is no value. */
	datePickerOpen?: () => string;
	/** DateInput: the calendar button's name with a value; `date` is the long form (`Intl` `dateStyle: 'full'`). */
	datePickerChange?: (date: string) => string;
	/** DateInput: the calendar dialog's accessible name. */
	datePickerDialog?: () => string;
	/** DateInput: the previous-month button. */
	datePickerPrevMonth?: () => string;
	/** DateInput: the next-month button. */
	datePickerNextMonth?: () => string;
	/** DateInput: the previous-year button. */
	datePickerPrevYear?: () => string;
	/** DateInput: the next-year button. */
	datePickerNextYear?: () => string;
	/** DateInput: the button that picks today. */
	datePickerToday?: () => string;
	/** DateInput: the button that empties the value. */
	datePickerClear?: () => string;
	/** DateInput: the format hint read with the text box (`aria-describedby`). */
	dateFormatHint?: () => string;
	/** TimeInput: the list button's name (the button is for the mouse, `tabindex="-1"`). */
	timePickerOpen?: () => string;
	/** TimeInput: the time list's accessible name (`role="listbox"`). */
	timePickerList?: () => string;
	/** TimeInput: the format hint read with the text box (`aria-describedby`). */
	timeFormatHint?: () => string;
	/** DateTimeInput: the picker button's name while there is no value. */
	dateTimePickerOpen?: () => string;
	/** DateTimeInput: the picker button's name with a value; `dateTime` is the long date and the `HH:mm` time. */
	dateTimePickerChange?: (dateTime: string) => string;
	/** DateTimeInput: the dialog's accessible name (the calendar and the time list). */
	dateTimePickerDialog?: () => string;
	/** DateTimeInput: the format hint read with the text box (`aria-describedby`). */
	dateTimeFormatHint?: () => string;
	/** DateRangeInput: the start day's text box. */
	dateRangeStart?: () => string;
	/** DateRangeInput: the end day's text box. */
	dateRangeEnd?: () => string;
}

export const defaultUiMessages: Required<UiMessages> = {
	loading: () => '読み込み中…',
	commandPaletteLabel: () => 'コマンドパレット',
	commandPalettePlaceholder: () => 'コマンドを検索…',
	commandPaletteListLabel: () => 'コマンド一覧',
	commandPaletteEmpty: () => '一致するコマンドがありません',
	commandPaletteRecent: () => '最近使ったもの',
	toastClose: () => '閉じる',
	overlayClose: () => '閉じる',
	datePickerOpen: () => '日付を選択',
	datePickerChange: (date) => `日付を変更、${date}`,
	datePickerDialog: () => '日付の選択',
	datePickerPrevMonth: () => '前の月',
	datePickerNextMonth: () => '次の月',
	datePickerPrevYear: () => '前の年',
	datePickerNextYear: () => '次の年',
	datePickerToday: () => '今日',
	datePickerClear: () => 'クリア',
	dateFormatHint: () => 'YYYY-MM-DD の形で入力（例: 2026-11-07）',
	timePickerOpen: () => '時刻を選択',
	timePickerList: () => '時刻の一覧',
	timeFormatHint: () => 'HH:mm の形で入力（例: 09:30）',
	dateTimePickerOpen: () => '日時を選択',
	dateTimePickerChange: (dateTime) => `日時を変更、${dateTime}`,
	dateTimePickerDialog: () => '日時の選択',
	dateTimeFormatHint: () => 'YYYY-MM-DD HH:mm の形で入力（例: 2026-11-07 09:30）',
	dateRangeStart: () => '開始日',
	dateRangeEnd: () => '終了日'
};
