<script lang="ts">
	/** Private, nonmodal error reader. The grid retains ownership of edit state. */
	import { untrack } from 'svelte';
	import {
		intersectErrorBounds,
		positionCellError,
		type ErrorPosition
	} from './cell-error-position';

	interface Props {
		frame: HTMLDivElement | undefined;
		grid: HTMLDivElement | undefined;
		editor: HTMLInputElement | HTMLSelectElement | undefined;
		element?: HTMLDivElement;
		sessionId: number;
		anchorLayout: string;
		errorId: string;
		message: string;
		label: string;
		hint: string;
		onReturn: (sessionId: number) => boolean;
	}
	let {
		frame,
		grid,
		editor,
		element = $bindable(),
		sessionId,
		anchorLayout,
		errorId,
		message,
		label,
		hint,
		onReturn
	}: Props = $props();
	let position: ErrorPosition | null = $state(null);
	let frameHeight = $state(0);
	const hintId = $derived(`${errorId}-hint`);

	function updatePosition() {
		if (!frame?.isConnected || !grid?.isConnected || !editor?.isConnected || !element) {
			position = null;
			return;
		}
		for (let node: HTMLElement | null = editor; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (style.display === 'none' || style.visibility === 'hidden') {
				position = null;
				return;
			}
		}
		const f = frame.getBoundingClientRect();
		const g = grid.getBoundingClientRect();
		const e = editor.getBoundingClientRect();
		// DOM-only consumers/tests can provide a clientHeight without a layout
		// engine. Keep the semantic error available; real hidden grids have 0.
		if (f.width === 0 && g.width === 0 && e.width === 0 && grid.clientHeight > 0) {
			position = {
				left: 0,
				top: 0,
				width: Math.max(1, grid.clientWidth),
				maxHeight: grid.clientHeight
			};
			return;
		}
		const sx = frame.offsetWidth > 0 ? f.width / frame.offsetWidth : 1;
		const sy = frame.offsetHeight > 0 ? f.height / frame.offsetHeight : 1;
		if (sx <= 0 || sy <= 0) {
			position = null;
			return;
		}
		frameHeight = f.height / sy;
		const win = grid.ownerDocument.defaultView!;
		const visual = win.visualViewport;
		const browserLeft = visual?.offsetLeft ?? 0;
		const browserTop = visual?.offsetTop ?? 0;
		const left = Math.max(g.left + grid.clientLeft * sx, browserLeft);
		const top = Math.max(g.top + grid.clientTop * sy, browserTop);
		const right = Math.min(
			g.left + (grid.clientLeft + grid.clientWidth) * sx,
			browserLeft + (visual?.width ?? win.innerWidth)
		);
		const bottom = Math.min(
			g.top + (grid.clientTop + grid.clientHeight) * sy,
			browserTop + (visual?.height ?? win.innerHeight)
		);
		const style = getComputedStyle(element);
		let bounds = {
			left: (left - f.left) / sx,
			top: (top - f.top) / sy,
			width: (right - left) / sx,
			height: (bottom - top) / sy
		};
		const clips = /^(auto|scroll|hidden|clip|overlay)$/;
		for (let ancestor = grid.parentElement; ancestor; ancestor = ancestor.parentElement) {
			const ancestorStyle = getComputedStyle(ancestor);
			const x = clips.test(ancestorStyle.overflowX);
			const y = clips.test(ancestorStyle.overflowY);
			if (!x && !y) continue;
			const a = ancestor.getBoundingClientRect();
			const ax = ancestor.offsetWidth > 0 ? a.width / ancestor.offsetWidth : 1;
			const ay = ancestor.offsetHeight > 0 ? a.height / ancestor.offsetHeight : 1;
			bounds = intersectErrorBounds(
				bounds,
				{
					left: (a.left + ancestor.clientLeft * ax - f.left) / sx,
					top: (a.top + ancestor.clientTop * ay - f.top) / sy,
					width: (ancestor.clientWidth * ax) / sx,
					height: (ancestor.clientHeight * ay) / sy
				},
				x,
				y
			);
		}
		const next = positionCellError(
			bounds,
			{
				left: (e.left - f.left) / sx,
				top: (e.top - f.top) / sy,
				width: e.width / sx,
				height: e.height / sy
			},
			// Radius is a stable theme length. Padding shrinks in tiny regions,
			// so feeding it back into positioning would create a layout loop.
			parseFloat(style.borderTopLeftRadius || '0')
		);
		if (
			!next ||
			!position ||
			(['left', 'top', 'bottomEdge', 'width', 'maxHeight'] as const).some(
				(key) => next[key as keyof ErrorPosition] !== position![key as keyof ErrorPosition]
			)
		)
			position = next;
	}

	$effect(() => {
		// Update for content/anchor changes, but never depend on our own geometry.
		const nodes = [frame, grid, editor, element];
		void message;
		void label;
		void hint;
		void anchorLayout;
		untrack(updatePosition);
		const win = grid?.ownerDocument.defaultView;
		if (!win) return;
		const observer = new ResizeObserver(updatePosition);
		for (const node of nodes) if (node) observer.observe(node);
		// Ancestor scrollports can resize independently of a fixed-size grid.
		for (let node = grid?.parentElement; node; node = node.parentElement) observer.observe(node);
		win.addEventListener('scroll', updatePosition, true);
		win.addEventListener('resize', updatePosition);
		win.visualViewport?.addEventListener('resize', updatePosition);
		win.visualViewport?.addEventListener('scroll', updatePosition);
		return () => {
			observer.disconnect();
			win.removeEventListener('scroll', updatePosition, true);
			win.removeEventListener('resize', updatePosition);
			win.visualViewport?.removeEventListener('resize', updatePosition);
			win.visualViewport?.removeEventListener('scroll', updatePosition);
		};
	});
</script>

<!-- A named scroll region needs keyboard focus to expose its full text.
     It remains nonmodal; only Escape/Shift+Tab return to the editor. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={element}
	class="cell-error-region"
	data-edit-session={sessionId}
	role="region"
	tabindex="0"
	aria-label={label}
	aria-describedby={`${errorId} ${hintId}`}
	hidden={!position}
	style:left={`${position?.left ?? 0}px`}
	style:top={position?.top === undefined ? undefined : `${position.top}px`}
	style:bottom={position?.bottomEdge === undefined
		? undefined
		: `${frameHeight - position.bottomEdge}px`}
	style:--banto-cell-error-width={`${position?.width ?? 0}px`}
	style:--banto-cell-error-height={`${position?.maxHeight ?? 0}px`}
	onkeydown={(event) => {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
		if (
			(event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) &&
			onReturn(sessionId)
		) {
			event.preventDefault();
			event.stopPropagation();
		}
	}}
>
	<div id={errorId} role="alert">{message}</div>
	<p id={hintId} class="hint">{hint}</p>
</div>

<style>
	.cell-error-region {
		position: absolute;
		z-index: calc(var(--banto-z-header) - 1);
		box-sizing: border-box;
		min-width: 0;
		width: var(--banto-cell-error-width);
		max-height: var(--banto-cell-error-height);
		overflow: auto;
		overscroll-behavior: contain;
		/* Private geometry values keep padding and borders inside even a
		   very small clipped viewport; leave space for scrollable content. */
		padding: min(
			var(--banto-space-3),
			calc(var(--banto-cell-error-width) / 8),
			calc(var(--banto-cell-error-height) / 8)
		);
		border: min(
				var(--banto-border-width-strong),
				calc(var(--banto-cell-error-width) / 8),
				calc(var(--banto-cell-error-height) / 8)
			)
			solid var(--banto-danger-solid);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-surface-overlay);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		box-shadow: var(--banto-shadow-md);
	}
	.cell-error-region:focus-visible {
		outline: var(--banto-border-width-strong) solid var(--banto-primary);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
	}
	.hint {
		margin: var(--banto-space-2) 0 0;
	}
	@media (forced-colors: active) {
		.cell-error-region {
			border-color: CanvasText;
			background: Canvas;
			color: CanvasText;
		}
		.cell-error-region:focus-visible {
			outline-color: Highlight;
		}
	}
</style>
