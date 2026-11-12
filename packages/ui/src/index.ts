/**
 * Public entry point for @banto/ui (docs/adr/0018-shared-ui-package.md).
 *
 * Phase 1: the seven general-purpose components that used to live in
 * apps/admin-template/src/lib/components/ui/. Phase 2a: the dropdown menu
 * parts (Menu, MenuGroup, MenuItem, MenuSeparator) from components/menu/.
 * Phase 2b: CommandPalette (display + interaction; the app keeps the command
 * list, Ctrl+K, session scoping, recent items and notifications).
 * Phase 2c: ToastHost + `createToastStore()` (the package's only `.svelte.ts`,
 * so consumers must list `@banto/ui` in `optimizeDeps.exclude`, ADR-0007; the
 * app keeps only the Notifier -> store wiring).
 * Phase 4: Modal / Drawer (banto-industrial banto-hub's, prop for prop) and the
 * Esc / focus layering helpers they share with CommandPalette (`layering.ts`,
 * one module for all overlays and public for an app's own layers).
 * Phase 5: LauncherBar, the dock-like icon launcher, with its types and the
 * pure `magnifyScale` curve (`launcher.ts`; docs/design/nav-launcher-plan.md -
 * the app keeps the nav definition, routing, `active`, RBAC and the text).
 * #435-a: command definitions and shortcut protection (`shortcut.ts`:
 * `CommandSpec`, `shouldHandleShortcut`, `createShortcutDispatcher`, the key
 * parse / match / format helpers) plus `hasVisibleModalLayer` in
 * `layering.ts` (docs/design/shared-primitives-upstream-plan.md §3.6, D2-a -
 * the app keeps the key wiring and the command list).
 * Date pickers (docs/design/date-time-pickers.md PR-1): `DateInput` and the
 * pure date helpers of `datetime.ts` (parse / calendar / `Intl` names), with
 * the popover placement shared with Menu (`anchoredPopover.ts`, internal).
 * PR-2: `TimeInput` (combobox + listbox, step) and the time helpers.
 * PR-5: `DateTimeInput` (one text box, one dialog: the calendar and a time
 * list) and the date-and-time helpers.
 * PR-6: `DateRangeInput` (two `DateInput`s in a `role="group"`, inclusive
 * days; the grid's filter turns them into a half-open `between`).
 * Components take text, icons, state and actions through props / snippets /
 * callbacks and import nothing but `svelte` (verify:architecture rule
 * `package-bare-imports`). Consumers
 * load `@banto/theme/css` themselves - the styles reference only `--banto-*`
 * tokens.
 */
export { default as CommandPalette } from './CommandPalette.svelte';
export { default as DateInput } from './DateInput.svelte';
export { default as TimeInput } from './TimeInput.svelte';
export { default as DateTimeInput } from './DateTimeInput.svelte';
export { default as DateRangeInput } from './DateRangeInput.svelte';
export {
	DEFAULT_TIME_STEP,
	addDays,
	addMonths,
	addYears,
	clampDate,
	dayOfWeek,
	daysInMonth,
	formatDateTimeText,
	formatFullDate,
	formatMonthYear,
	isBlankDateText,
	formatTime,
	isIsoDate,
	isIsoDateTime,
	isIsoTime,
	isLeapYear,
	joinDateTime,
	isOnTimeStep,
	isOutOfRange,
	minutesToTime,
	monthGrid,
	nearestTime,
	normalizeTimeStep,
	parseDateText,
	parseDateTimeText,
	parseIsoDate,
	parseIsoDateTime,
	parseIsoTime,
	parseTimeText,
	resolveWeekStart,
	timeOptions,
	timeToMinutes,
	todayDate,
	weekdayNames,
	type DateParts,
	type DateTimeParts,
	type TimeParts,
	type Weekday
} from './datetime';
export { default as Drawer } from './Drawer.svelte';
export { default as Modal } from './Modal.svelte';
export type { DrawerProps, ModalProps, OverlayProps } from './overlay';
export {
	attachFocusTrap,
	canRestoreFocusTo,
	effectiveZIndex,
	FOCUSABLE_SELECTOR,
	focusablesIn,
	hasVisibleLayerAbove,
	hasVisibleMenuLayer,
	hasVisibleModalLayer,
	isCloseAllowed,
	LAYER_INACTIVE_ATTR,
	LAYER_MARKER_ATTR,
	LAYER_SELECTOR,
	MENU_LAYER_SELECTOR,
	MODAL_LAYER_SELECTOR,
	restoreFocus,
	type OverlayCloseSource
} from './layering';
export {
	defaultCommandPaletteSearch,
	type CommandPaletteCloseReason,
	type CommandPaletteItem
} from './commandPalette';
export {
	createShortcutDispatcher,
	detectShortcutPlatform,
	formatShortcut,
	isEditableTarget,
	matchShortcut,
	parseShortcut,
	shouldHandleShortcut,
	type CommandSpec,
	type ParsedShortcut,
	type ShortcutDispatcher,
	type ShortcutPlatform
} from './shortcut';
export { default as EmptyState } from './EmptyState.svelte';
export { default as ErrorState } from './ErrorState.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as LauncherBar } from './LauncherBar.svelte';
export {
	LAUNCHER_MAGNIFY_RANGE_ITEMS,
	magnifyScale,
	type LauncherGroup,
	type LauncherItem,
	type LauncherPosition
} from './launcher';
export { default as LoadingState } from './LoadingState.svelte';
export { default as Menu } from './Menu.svelte';
export { default as MenuGroup } from './MenuGroup.svelte';
export { default as MenuItem } from './MenuItem.svelte';
export { default as MenuSeparator } from './MenuSeparator.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as StatusBadge } from './StatusBadge.svelte';
export { default as SurfaceCard } from './SurfaceCard.svelte';
export { default as ToastHost } from './ToastHost.svelte';
export {
	createToastStore,
	DEFAULT_TOAST_DURATION_MS,
	type Toast,
	type ToastAction,
	type ToastKind,
	type ToastPushOptions,
	type ToastStore,
	type ToastStoreOptions
} from './toast.svelte';
export { defaultUiMessages, type UiMessages } from './messages';
export type { StatusBadgeVariant, UiIconComponent } from './types';
