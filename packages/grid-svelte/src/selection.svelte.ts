/**
 * Reactive cell selection/navigation state (Svelte 5 runes), spec §4.5:
 * a single active cell plus an optional Excel-like rectangular range anchored
 * at the cell where the gesture (shift-click / drag / shift+arrow) started.
 *
 * Grid-agnostic and unit-testable: no DOM access, no dependency on
 * BantoGrid's rows/columns beyond the `orderedFields` (column ids in current
 * display order) callers pass in per call.
 */
import type { CellRange } from './types';

export interface CellPos {
	rowIndex: number;
	field: string;
}

export class CellSelection {
	active: CellPos | null = $state(null);
	/** Fixed corner of the range; set together with `active` unless extending. */
	anchor: CellPos | null = $state(null);
	/** Opposite corner of the range from `anchor`. Null when there is no range (single cell). */
	rangeEnd: CellPos | null = $state(null);

	/**
	 * Set the active cell. `extend: true` keeps the existing `anchor` (or
	 * seeds it from the current `active` if there wasn't one yet) and moves
	 * `rangeEnd` to the new position, producing a range; `extend: false`
	 * collapses to a single-cell selection at the new position.
	 */
	setActive(rowIndex: number, field: string, extend: boolean): void {
		const next = { rowIndex, field };
		if (extend) {
			if (!this.anchor) this.anchor = this.active ?? next;
			this.rangeEnd = next;
			this.active = next;
		} else {
			this.active = next;
			this.anchor = next;
			this.rangeEnd = null;
		}
	}

	/**
	 * Move the active cell by `(dRow, dField)`, clamped to `[0, rowCount)` and
	 * `[0, orderedFields.length)`. Row and field movement are independent
	 * (e.g. Tab only changes the field, never wraps to another row).
	 */
	moveActive(
		dRow: number,
		dField: number,
		extend: boolean,
		rowCount: number,
		orderedFields: string[]
	): void {
		if (!this.active) return;
		const fieldIndex = orderedFields.indexOf(this.active.field);
		const nextRowIndex = clamp(this.active.rowIndex + dRow, 0, rowCount - 1);
		const nextFieldIndex = clamp(
			(fieldIndex === -1 ? 0 : fieldIndex) + dField,
			0,
			orderedFields.length - 1
		);
		const nextField = orderedFields[nextFieldIndex] ?? this.active.field;
		this.setActive(nextRowIndex, nextField, extend);
	}

	/** Normalized inclusive range in display-order field indices, or null when there's no anchor. */
	getRange(orderedFields: string[]): CellRange | null {
		if (!this.anchor) return null;
		const end = this.rangeEnd ?? this.active ?? this.anchor;
		const anchorFieldIndex = orderedFields.indexOf(this.anchor.field);
		const endFieldIndex = orderedFields.indexOf(end.field);
		if (anchorFieldIndex === -1 || endFieldIndex === -1) return null;
		return {
			rowStart: Math.min(this.anchor.rowIndex, end.rowIndex),
			rowEnd: Math.max(this.anchor.rowIndex, end.rowIndex),
			fieldStart: Math.min(anchorFieldIndex, endFieldIndex),
			fieldEnd: Math.max(anchorFieldIndex, endFieldIndex)
		};
	}

	/** Whether (rowIndex, fieldIndex) — a display-order field index — falls inside the current range. */
	isSelected(rowIndex: number, fieldIndex: number, orderedFields: string[]): boolean {
		const range = this.getRange(orderedFields);
		if (!range) return false;
		return (
			rowIndex >= range.rowStart &&
			rowIndex <= range.rowEnd &&
			fieldIndex >= range.fieldStart &&
			fieldIndex <= range.fieldEnd
		);
	}

	clear(): void {
		this.active = null;
		this.anchor = null;
		this.rangeEnd = null;
	}
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.min(max, Math.max(min, value));
}
