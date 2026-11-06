/**
 * Public entry point for @banto/scan-wedge (docs/roadmap.md M21). Headless
 * core + DOM wrapper + Svelte 5 actions for detecting keyboard-wedge
 * barcode/QR scanner input.
 */
export {
	createWedgeDetector,
	type WedgeOptions,
	type WedgeKeyEvent,
	type WedgeDetector,
	type ScanInfo
} from './core/detector';
export { listenWedge, type ListenWedgeOptions } from './listen';
export {
	wedgeInput,
	type WedgeInputOptions,
	keepFocused,
	type KeepFocusedOptions
} from './actions';
