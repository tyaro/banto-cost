/**
 * Injected field inputs (date-time-pickers §5.7, D1-a / D3-a): the app hands
 * forms the picker components, forms never imports them (conventions §4,
 * shared-primitives-upstream-plan §2.1 - "the app connects the two").
 *
 * - `provideFieldInputs({ date, time, datetime })` in a layout puts them in the component
 *   context for every `BantoForm` / `DraftDateField` below it; the
 *   `fieldInputs` / `input` prop of one form or field overrides it, per type.
 * - A type with no injected component keeps the native input
 *   (`<input type="date">` / `"time"` / `"datetime-local"`), so forms used
 *   on its own still works (D3-a).
 *
 * `DateFieldInputProps` / `TimeFieldInputProps` / `DateTimeFieldInputProps`
 * are STRUCTURAL descriptions of what forms passes - the subsets of
 * `@banto/ui`'s `DateInput` / `TimeInput` / `DateTimeInput` props it uses
 * (§5.2), so those components (or an app wrapper that adds `messages` /
 * `locale`) fit as they are.
 */
import { getContext, setContext, type Component } from 'svelte';

/** Props forms passes to an injected date input (a subset of `@banto/ui` `DateInput`'s, §5.2). */
export interface DateFieldInputProps {
	/** Canonical `YYYY-MM-DD`, or `null`. The FormStore path may pass text that did not parse (§5.3). */
	value?: string | null;
	/** The committed value (canonical or `null`). */
	onValueChange?: (value: string | null) => void;
	/** Typed text owned by forms (the `FormDraft` path). Omitted: the component keeps it. */
	text?: string;
	/** Every change of the typed text. */
	onTextInput?: (text: string) => void;
	/** id of the text box (the form's `<label for>` points at it). */
	id?: string;
	/** Extra ids for the text box's `aria-describedby` (the field's error). */
	describedBy?: string;
	invalid?: boolean;
	disabled?: boolean;
	readonly?: boolean;
	/** Earliest day (canonical, inclusive). */
	min?: string;
	/** Latest day (canonical, inclusive). */
	max?: string;
	isDateDisabled?: (date: string) => boolean;
	/** Keys from the text box (Enter with the popover closed arrives after the component committed). */
	onkeydown?: (event: KeyboardEvent) => void;
	/** Focus left the whole component, after the text was committed. */
	onblur?: (event: FocusEvent) => void;
}

/** Props forms passes to an injected time input (a subset of `@banto/ui` `TimeInput`'s, §5.2). */
export interface TimeFieldInputProps extends Omit<
	DateFieldInputProps,
	'min' | 'max' | 'isDateDisabled'
> {
	/** Canonical `HH:mm`, or `null`. The FormStore path may pass text that did not parse (§5.3). */
	value?: string | null;
	/** Earliest time (canonical `HH:mm`, inclusive). */
	min?: string;
	/** Latest time (canonical `HH:mm`, inclusive). */
	max?: string;
	/** Minutes between the listed times, counted from 00:00 (`FieldDef.step`, D8). */
	step?: number;
}

/** Props forms passes to an injected date-and-time input (a subset of `@banto/ui` `DateTimeInput`'s, §5.2). */
export interface DateTimeFieldInputProps extends Omit<DateFieldInputProps, 'min' | 'max'> {
	/** Canonical `YYYY-MM-DDTHH:mm`, or `null`. The FormStore path may pass text that did not parse (§5.3). */
	value?: string | null;
	/** Earliest date and time (canonical `YYYY-MM-DDTHH:mm`, inclusive). */
	min?: string;
	/** Latest date and time (canonical `YYYY-MM-DDTHH:mm`, inclusive). */
	max?: string;
	/** Minutes between the listed times, counted from 00:00 (`FieldDef.step`, D8). */
	step?: number;
}

/**
 * What `DateField` / `DraftDateField` pass to the input of any of the three
 * types: every injected input above accepts it (each ignores what it does
 * not take).
 */
export type TemporalFieldInputProps = DateFieldInputProps & { step?: number };

/** Components forms renders instead of its native inputs, by field type. */
export interface FieldInputs {
	date?: Component<DateFieldInputProps>;
	time?: Component<TimeFieldInputProps>;
	datetime?: Component<DateTimeFieldInputProps>;
}

const FIELD_INPUTS = Symbol('banto-forms-field-inputs');

/**
 * Provide the field inputs for every form below the calling component
 * (call it during component initialisation, e.g. in a layout's `<script>`).
 * Returns what it set.
 */
export function provideFieldInputs(inputs: FieldInputs): FieldInputs {
	return setContext(FIELD_INPUTS, inputs);
}

/** The field inputs provided above the calling component (`{}` when none). Call during initialisation. */
export function getFieldInputs(): FieldInputs {
	return getContext<FieldInputs | undefined>(FIELD_INPUTS) ?? {};
}
