import type { Snippet } from 'svelte';
import type { UiMessages } from './messages';

/**
 * Props shared by `Modal` (centred, fade + scale, default width 560px) and
 * `Drawer` (right edge, full height, fade + slide, default width 480px) -
 * docs/adr/0018-shared-ui-package.md §10, phase 4. The contract is
 * banto-industrial banto-hub's (T13-1 / T19 S1-b / TAG-UX-C / #381), kept
 * prop-for-prop so its migration is an import swap.
 *
 * The parent owns `open`: the component never sets it, it asks through
 * `onRequestClose` and announces through `onclose`.
 */
export interface OverlayProps {
	/** Whether the layer is shown. Controlled by the parent (set it to `false` from `onclose`). */
	open: boolean;
	/** Heading text and the dialog's accessible name (`aria-label`). Give one - a dialog needs a name. */
	title?: string;
	/** Any CSS length (`'480px'`, `'36rem'`). Capped at the viewport width minus 2rem. */
	width?: string;
	/** Close on a click on the scrim itself (not on a click that bubbled from the panel). Default `true`. */
	closeOnOverlayClick?: boolean;
	/** Called once the close was allowed (Esc, scrim, × or after `onRequestClose` returned `true`). */
	onclose?: () => void;
	/**
	 * Asked before every close (Esc, scrim, ×). Return `false` to stay open -
	 * e.g. an unsaved-changes confirm or "busy, not now". Omitted = always allowed.
	 */
	onRequestClose?: () => boolean;
	/**
	 * Unsaved changes: while `true`, Esc and the scrim click do **not** close
	 * (accidental routes) and `onBlockedClose` is called instead. The × still
	 * goes through `onRequestClose`. Default `false`.
	 */
	dirty?: boolean;
	/** Called when `dirty` blocked an Esc / scrim close - show a hint (e.g. a toast). */
	onBlockedClose?: () => void;
	/**
	 * Where focus goes on close when the element that had it at open time is
	 * gone, inert or hidden (e.g. the row was deleted, or the context menu that
	 * opened the layer unmounted). Default: nowhere (focus is left alone).
	 */
	focusFallback?: () => HTMLElement | null | undefined;
	/** Text overrides (layer 1 i18n): `overlayClose`. Defaults: `defaultUiMessages`. */
	messages?: UiMessages;
	/** Panel body. */
	children?: Snippet;
}

export type ModalProps = OverlayProps;
export type DrawerProps = OverlayProps;
