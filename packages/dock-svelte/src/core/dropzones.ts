/**
 * Pure drop-region geometry (spec §5.2: "画面端・グループ端にドロップして
 * 分割（上下左右スナップ）"). No Svelte imports - Phase B will call
 * `computeDropRegion` on pointer-move to decide which snap-guide overlay to
 * draw and, on drop, which `DropRegion` to pass to
 * `core/tree.ts#dockPanelIntoTree`.
 */
import type { DropRegion } from '../types';

/**
 * Given a pointer position (`localX`, `localY`) inside a drop target's rect
 * (`width` x `height`, both in the same units, origin top-left), return which
 * `DropRegion` it falls in. An edge band of `edgeRatio` (fraction of the
 * corresponding dimension) on each side maps to that edge; everything else is
 * `'center'`. A point in two bands at once (a corner) resolves to whichever
 * edge is normalized-distance-closer; on an exact tie, priority is
 * left > right > top > bottom (stable sort order below - arbitrary but
 * deterministic).
 *
 * Boundary convention: a point exactly `edgeRatio * dimension` from an edge
 * is NOT in that edge's band (strict `<`), so it resolves to `'center'`
 * unless it's within another edge's band.
 */
export function computeDropRegion(
	localX: number,
	localY: number,
	width: number,
	height: number,
	edgeRatio = 0.25
): DropRegion {
	if (width <= 0 || height <= 0) return 'center';

	const leftDist = localX / width;
	const rightDist = (width - localX) / width;
	const topDist = localY / height;
	const bottomDist = (height - localY) / height;

	const candidates: { region: DropRegion; dist: number }[] = [];
	if (leftDist < edgeRatio) candidates.push({ region: 'left', dist: leftDist });
	if (rightDist < edgeRatio) candidates.push({ region: 'right', dist: rightDist });
	if (topDist < edgeRatio) candidates.push({ region: 'top', dist: topDist });
	if (bottomDist < edgeRatio) candidates.push({ region: 'bottom', dist: bottomDist });

	if (candidates.length === 0) return 'center';

	candidates.sort((a, b) => a.dist - b.dist);
	return candidates[0].region;
}
