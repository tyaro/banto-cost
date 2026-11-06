/**
 * Pure validation of a restored `DockLayout` (spec §5.1: layout JSON
 * serialize/restore; shared-primitives-upstream-plan §3.2, Issue #434).
 *
 * One function is shared by `DockState`'s constructor (object / string
 * initial value), `DockState.hydrate`, and any app that wants to inspect a
 * stored payload before adopting it. It never throws and never mutates its
 * input: on success it returns a v2 layout (a v1 payload is migrated with
 * `docked: null`, split `sizes` are repaired via `normalizeSizes`); on
 * failure it returns every issue found so the caller can reject the payload
 * as a whole instead of adopting part of it.
 *
 * Deliberately NOT checked: whether a panel id is known to the consumer's
 * registry. Unknown ids are kept as-is (the host component / consumer decides
 * at render time), which is a separate policy from structural validity.
 */
import { normalizeSizes } from './tree';
import type { DockLayout, DockNode, FloatingWindow } from '../types';

export type DockLayoutIssueCode =
	| 'version'
	| 'shape'
	| 'duplicate-id'
	| 'non-finite'
	| 'non-positive-size'
	| 'split-sizes'
	| 'active-index';

export interface DockLayoutIssue {
	readonly code: DockLayoutIssueCode;
	/** Location of the offending value, e.g. `floating[2].width`, `docked.children[1]`. */
	readonly path: string;
}

export type DockLayoutValidation =
	| { readonly ok: true; readonly layout: DockLayout }
	| { readonly ok: false; readonly issues: readonly DockLayoutIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted value (parsed JSON or a caller-supplied object) as a
 * v1 or v2 `DockLayout`. Pure. A returned layout is safe to adopt wholesale.
 */
export function validateDockLayout(value: unknown): DockLayoutValidation {
	const issues: DockLayoutIssue[] = [];
	const add = (code: DockLayoutIssueCode, path: string): void => {
		issues.push({ code, path });
	};

	if (!isRecord(value)) {
		add('shape', '');
		return { ok: false, issues };
	}
	if (value.version !== 1 && value.version !== 2) {
		add('version', 'version');
		return { ok: false, issues };
	}

	// Floating windows and docked panels share one id space (types.ts); split
	// / tabs group ids are tracked in the same set so no two nodes collide.
	const seen = new Set<string>();
	const claimId = (id: string, path: string): void => {
		if (seen.has(id)) add('duplicate-id', path);
		else seen.add(id);
	};

	// Index every slot instead of `forEach`, which skips the holes of a sparse
	// array (`Array(1)`) and would let an empty slot through to the renderer.
	const eachSlot = (arr: unknown[], p: string, fn: (item: unknown, path: string) => void): void => {
		for (let i = 0; i < arr.length; i++) {
			const path = `${p}[${i}]`;
			if (!(i in arr)) add('shape', path);
			else fn(arr[i], path);
		}
	};

	const floating: FloatingWindow[] = [];
	if (!Array.isArray(value.floating)) {
		add('shape', 'floating');
	} else {
		eachSlot(value.floating, 'floating', (raw, p) => {
			if (!isRecord(raw)) return add('shape', p);
			if (typeof raw.id !== 'string' || raw.id === '') add('shape', `${p}.id`);
			else claimId(raw.id, `${p}.id`);
			if (typeof raw.title !== 'string') add('shape', `${p}.title`);
			if (raw.icon !== undefined && typeof raw.icon !== 'string') add('shape', `${p}.icon`);
			if (typeof raw.open !== 'boolean') add('shape', `${p}.open`);
			for (const key of ['x', 'y'] as const) {
				const n = raw[key];
				if (typeof n !== 'number') add('shape', `${p}.${key}`);
				else if (!Number.isFinite(n)) add('non-finite', `${p}.${key}`);
			}
			for (const key of ['width', 'height'] as const) {
				const n = raw[key];
				if (typeof n !== 'number') add('shape', `${p}.${key}`);
				else if (!Number.isFinite(n)) add('non-finite', `${p}.${key}`);
				else if (!(n > 0)) add('non-positive-size', `${p}.${key}`);
			}
			floating.push(raw as unknown as FloatingWindow);
		});
	}

	// A caller-supplied object can contain itself; stop at the first revisit so
	// the validator never recurses forever (it must not throw for any input).
	const visited = new WeakSet<object>();
	const checkNode = (raw: unknown, p: string, inTabs: boolean): void => {
		if (!isRecord(raw)) return add('shape', p);
		if (visited.has(raw)) return add('shape', p);
		visited.add(raw);
		if (typeof raw.id !== 'string' || raw.id === '') add('shape', `${p}.id`);
		else claimId(raw.id, `${p}.id`);
		if (raw.type === 'panel') {
			if (typeof raw.title !== 'string') add('shape', `${p}.title`);
			if (raw.icon !== undefined && typeof raw.icon !== 'string') add('shape', `${p}.icon`);
			return;
		}
		if (inTabs) return add('shape', `${p}.type`); // tab groups hold panels only
		if (raw.type === 'tabs') {
			if (!Array.isArray(raw.children) || raw.children.length === 0) {
				return add('shape', `${p}.children`);
			}
			eachSlot(raw.children, `${p}.children`, (c, cp) => checkNode(c, cp, true));
			const n = raw.children.length;
			const active = raw.activeIndex;
			if (typeof active !== 'number' || !Number.isInteger(active) || active < 0 || active >= n) {
				add('active-index', `${p}.activeIndex`);
			}
			return;
		}
		if (raw.type === 'split') {
			if (raw.direction !== 'row' && raw.direction !== 'column') add('shape', `${p}.direction`);
			if (!Array.isArray(raw.children) || raw.children.length < 2) {
				return add('split-sizes', `${p}.children`);
			}
			eachSlot(raw.children, `${p}.children`, (c, cp) => checkNode(c, cp, false));
			const sizes = raw.sizes;
			if (!Array.isArray(sizes) || sizes.length !== raw.children.length) {
				return add('split-sizes', `${p}.sizes`);
			}
			let total = 0;
			let entriesOk = true;
			eachSlot(sizes, `${p}.sizes`, (s, sp) => {
				if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
					entriesOk = false;
					add('split-sizes', sp);
				} else total += s;
			});
			// Finite entries can still overflow when summed (`[1e308, 1e308]`),
			// which normalizeSizes would turn into an all-zero split.
			if (entriesOk && !Number.isFinite(total)) add('split-sizes', `${p}.sizes`);
			return;
		}
		add('shape', `${p}.type`);
	};

	let docked: DockNode | null = null;
	if (value.version === 2) {
		const rawDocked = value.docked;
		if (rawDocked === undefined) add('shape', 'docked');
		else if (rawDocked !== null) checkNode(rawDocked, 'docked', false);
		docked = (rawDocked ?? null) as DockNode | null;
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		layout: { version: 2, floating, docked: docked ? normalizeSizes(docked) : null }
	};
}
