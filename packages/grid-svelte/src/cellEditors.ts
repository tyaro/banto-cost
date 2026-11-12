/**
 * Injected cell editors (date-time-pickers §5.8, D1-a / D3-a): the app hands
 * the grid the picker components, the grid never imports them (conventions
 * §4, shared-primitives-upstream-plan §2.1 - "the app connects the two"). The
 * counterpart of @banto/forms' `provideFieldInputs`.
 *
 * - `provideCellEditors({ date, time, datetime })` in a layout puts them in the component
 *   context for every `BantoGrid` below it; the `cellEditors` prop of one
 *   grid overrides it, per editor type.
 * - A type with no injected component keeps the native input
 *   (`<input type="date">` / `"time"` / `"datetime-local"`), so the grid
 *   used on its own still works (D3-a).
 *
 * `CellDateEditorProps` / `CellTimeEditorProps` / `CellDateTimeEditorProps`
 * are STRUCTURAL descriptions of what the grid passes - the subsets of
 * `@banto/ui`'s `DateInput` / `TimeInput` / `DateTimeInput` props it uses
 * (§5.2), so those (or an app wrapper that adds `messages` / `locale`) fit
 * as they are.
 * The grid keeps its edit state machine (`BantoGrid.svelte`) and relies on
 * the component keeping §5.8's promises: keys inside its popover do not
 * propagate and Esc there closes only the popover; keys the text box handles
 * itself are `preventDefault`ed before `onkeydown`; `onblur` fires only when
 * focus leaves the whole component; `pointerdown` does not propagate out of
 * it (the grid also stops it on its own wrapper).
 */
import { getContext, setContext, type Component } from 'svelte';

/** Props the grid passes to an injected date editor (a subset of `@banto/ui` `DateInput`'s, §5.2). */
export interface CellDateEditorProps {
	/** The draft as a day: canonical `YYYY-MM-DD`, or `null` while the text is not one. */
	value?: string | null;
	/** The component's committed value (the grid reads the text instead, `onTextInput`). */
	onValueChange?: (value: string | null) => void;
	/** The cell's draft text, owned by the grid. */
	text?: string;
	/** Every change of the typed text, including the canonical rewrite and a picked day. */
	onTextInput?: (text: string) => void;
	/** Accessible name of the text box (the column header). */
	label?: string;
	/** Extra ids for the text box's `aria-describedby` (the cell's edit error). */
	describedBy?: string;
	invalid?: boolean;
	/** True while the commit is being saved: the calendar must not open. */
	readonly?: boolean;
	/** Earliest day (canonical, inclusive): `GridColumn.editorMin`. */
	min?: string;
	/** Latest day (canonical, inclusive): `GridColumn.editorMax`. */
	max?: string;
	/** `GridColumn.isDateDisabled`. */
	isDateDisabled?: (date: string) => boolean;
	/** Keys from the text box, after the component handled its own (Enter commits the text first). */
	onkeydown?: (event: KeyboardEvent) => void;
	/** Focus left the whole component, after the text was committed. */
	onblur?: (event: FocusEvent) => void;
	/** The text box (bindable): where the grid puts and returns focus. */
	inputEl?: HTMLInputElement;
}

/** Props the grid passes to an injected time editor (a subset of `@banto/ui` `TimeInput`'s, §5.2). */
export interface CellTimeEditorProps extends Omit<
	CellDateEditorProps,
	'value' | 'min' | 'max' | 'isDateDisabled'
> {
	/** The draft as a time: canonical `HH:mm`, or `null` while the text is not one. */
	value?: string | null;
	/** Earliest time (canonical `HH:mm`, inclusive): `GridColumn.editorMin`. */
	min?: string;
	/** Latest time (canonical `HH:mm`, inclusive): `GridColumn.editorMax`. */
	max?: string;
	/** Minutes between the listed times: `GridColumn.editorStep`. */
	step?: number;
}

/** Props the grid passes to an injected date-and-time editor (a subset of `@banto/ui` `DateTimeInput`'s, §5.2). */
export interface CellDateTimeEditorProps extends Omit<
	CellDateEditorProps,
	'value' | 'min' | 'max'
> {
	/** The draft as a date and time: canonical `YYYY-MM-DDTHH:mm`, or `null` while the text is not one. */
	value?: string | null;
	/** Earliest date and time (canonical `YYYY-MM-DDTHH:mm`, inclusive): `GridColumn.editorMin`. */
	min?: string;
	/** Latest date and time (canonical `YYYY-MM-DDTHH:mm`, inclusive): `GridColumn.editorMax`. */
	max?: string;
	/** Minutes between the listed times: `GridColumn.editorStep`. */
	step?: number;
}

/**
 * What `CellEditor` passes to the editor of any of the three types: every
 * injected editor above accepts it (each ignores what it does not take).
 */
export type CellTemporalEditorProps = CellDateEditorProps & { step?: number };

/**
 * Props FilterPopover passes to an injected day-range input (a subset of
 * `@banto/ui`'s `DateRangeInput` props, date-time-pickers §5.9, PR-6) for a
 * `date` / `datetime` column. Both ends are INCLUSIVE days; the popover turns
 * them into the half-open `between` value (`dateRangeToBetween`).
 */
export interface FilterDateRangeInputProps {
	/** The inclusive days, canonical `YYYY-MM-DD` or `null` (an open end). */
	value?: { from: string | null; to: string | null };
	onValueChange?: (value: { from: string | null; to: string | null }) => void;
	/** Every change of either box's typed text: the popover reads the text on apply. */
	onTextInput?: (end: 'from' | 'to', text: string) => void;
	/** Accessible name of the group (the popover's range label). */
	label?: string;
	/** The popover's error message, for both text boxes. */
	describedBy?: string;
	invalid?: boolean;
	/** `vertical`: the popover is narrow. */
	orientation?: 'horizontal' | 'vertical';
	/** Keys from either text box after the component handled its own (Enter applies). */
	onkeydown?: (event: KeyboardEvent) => void;
	/** The start day's text box (bindable): focused when the popover opens. */
	fromInputEl?: HTMLInputElement;
}

/**
 * Components the grid renders instead of its native inputs: the cell editors
 * by editor type, and `dateRange` for the filter of a `date` / `datetime`
 * column (FilterPopover; without it, two native `<input type="date">`).
 */
export interface CellEditors {
	date?: Component<CellDateEditorProps>;
	time?: Component<CellTimeEditorProps>;
	datetime?: Component<CellDateTimeEditorProps>;
	dateRange?: Component<FilterDateRangeInputProps>;
}

const CELL_EDITORS = Symbol('banto-grid-cell-editors');

/**
 * Provide the cell editors for every grid below the calling component (call
 * it during component initialisation, e.g. in a layout's `<script>`).
 * Returns what it set.
 */
export function provideCellEditors(editors: CellEditors): CellEditors {
	return setContext(CELL_EDITORS, editors);
}

/** The cell editors provided above the calling component (`{}` when none). Call during initialisation. */
export function getCellEditors(): CellEditors {
	return getContext<CellEditors | undefined>(CELL_EDITORS) ?? {};
}
