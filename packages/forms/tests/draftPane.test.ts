// @vitest-environment jsdom
/**
 * Draft wiring in components (shared-primitives-upstream-plan §3.5, Issue #432):
 *
 * - registering / writing from an `$effect` does not loop (effects only run
 *   here, not in the node tests),
 * - `DraftNumberField` keeps incomplete number text across a re-mount
 *   (dock / undock) and commits on blur / Enter,
 * - a `DraftCoordinator` joins `guardUnsavedChanges`' registry: a router leave
 *   with a dirty draft prompts, and a guard on the same screen does not add a
 *   second prompt ("one prompt per navigation").
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import DraftPaneHarness from './DraftPaneHarness.svelte';
import GuardHarness from './GuardHarness.svelte';
import { createFormDraft, draftSourceFrom } from '../src/draft.svelte';
import { createDraftCoordinator, type DraftCoordinator } from '../src/draftCoordinator.svelte';
import type { LeaveNavigation } from '../src/unsavedChanges.svelte';
import type { FieldDef } from '../src/types';

const def: FieldDef = { name: 'qty', label: 'Qty', type: 'number', max: 10 };
const coordinators: DraftCoordinator[] = [];
function setup() {
	const draft = createFormDraft({ key: 'memo', schema: { fields: [def] }, initial: { qty: 1 } });
	const coordinator = createDraftCoordinator({ message: () => 'drafts unsaved' });
	coordinators.push(coordinator);
	// The page owns the registration (the draft's lifetime), not the pane.
	coordinator.register(draftSourceFrom(draft, async () => true));
	return { draft, coordinator };
}
afterEach(() => {
	cleanup();
	for (const c of coordinators.splice(0)) c.dispose();
});

const input = () => screen.getByRole('textbox') as HTMLInputElement;
const state = () => screen.getByTestId('state').textContent;

describe('draft pane in a component', () => {
	it('registering and writing the draft from an $effect runs the effect once', () => {
		const { draft, coordinator } = setup();
		const onEffect = vi.fn();
		render(DraftPaneHarness, {
			draft,
			coordinator,
			def,
			seed: '5',
			onEffect,
			registerInPane: true
		});
		flushSync();
		expect(onEffect).toHaveBeenCalledTimes(1);
		expect(input().value).toBe('5');
		expect(state()).toBe('pending:dirty:1');
	});

	it('DraftNumberField keeps "1e" across a re-mount and commits on blur', async () => {
		const { draft, coordinator } = setup();
		const first = render(DraftPaneHarness, { draft, coordinator, def });
		expect(input().type).toBe('text');
		expect(input().inputMode).toBe('decimal');
		await fireEvent.input(input(), { target: { value: '1e' } });
		expect(draft.raw.qty).toBe('1e');
		first.unmount(); // dock / undock: the pane content is destroyed
		expect(coordinator.pending).toBe(true); // the draft belongs to the page, not the pane
		render(DraftPaneHarness, { draft, coordinator, def });
		expect(input().value).toBe('1e');
		expect(state()).toMatch(/^pending:dirty/);
		await fireEvent.blur(input());
		expect(input().getAttribute('aria-invalid')).toBe('true');
		await fireEvent.input(input(), { target: { value: '7' } });
		await fireEvent.keyDown(input(), { key: 'Enter' });
		expect(draft.values.qty).toBe(7);
		expect(input().getAttribute('aria-invalid')).toBe('false');
	});
});

function fakeRouter() {
	const callbacks: ((navigation: LeaveNavigation) => void)[] = [];
	return {
		beforeNavigate: (callback: (navigation: LeaveNavigation) => void) => {
			callbacks.push(callback);
		},
		navigate(): boolean {
			let cancelled = false;
			const navigation: LeaveNavigation = {
				type: 'link',
				from: { url: new URL('/here', 'http://app.test') },
				to: { url: new URL('/elsewhere', 'http://app.test') },
				cancel: () => {
					cancelled = true;
				}
			};
			callbacks.forEach((callback) => callback(navigation));
			return cancelled;
		}
	};
}

describe('a hidden pane with a dirty page-owned draft (#447 review)', () => {
	it('stays pending and is a settle target while the pane is unmounted', async () => {
		const { draft, coordinator } = setup();
		const pane = render(DraftPaneHarness, { draft, coordinator, def });
		await fireEvent.input(input(), { target: { value: '4' } });
		pane.unmount(); // hide / tab-switch without keepMounted
		expect(coordinator.pending).toBe(true);
		const asked: (readonly string[])[] = [];
		const result = await coordinator.settle(['memo'], async (keys) => {
			asked.push(keys);
			return 'cancel';
		});
		expect(result).toBe('cancelled');
		expect(asked).toEqual([['memo']]);
		expect(draft.dirty).toBe(true);
	});
});

describe('DraftCoordinator and guardUnsavedChanges', () => {
	it('a dirty draft makes a mounted guard prompt once with the coordinator message', async () => {
		const { draft, coordinator } = setup();
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		render(GuardHarness, {
			isDirty: () => false,
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'guard message'
		});
		render(DraftPaneHarness, { draft, coordinator, def });
		await fireEvent.input(input(), { target: { value: '3' } });
		expect(router.navigate()).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledWith('drafts unsaved');
	});

	it('the page guard over the coordinator plus its registry entry still prompt once', async () => {
		const { draft, coordinator } = setup();
		const router = fakeRouter();
		const confirm = vi.fn(() => true);
		render(DraftPaneHarness, { draft, coordinator, def });
		render(GuardHarness, {
			isDirty: () => coordinator.pending,
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'guard message'
		});
		render(GuardHarness, {
			isDirty: () => coordinator.pending,
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'guard message'
		});
		await fireEvent.input(input(), { target: { value: '3' } });
		expect(router.navigate()).toBe(false);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('a clean draft lets the navigation through without a prompt', () => {
		const { draft, coordinator } = setup();
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		render(DraftPaneHarness, { draft, coordinator, def });
		render(GuardHarness, {
			isDirty: () => false,
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'guard message'
		});
		expect(router.navigate()).toBe(false);
		expect(confirm).not.toHaveBeenCalled();
	});
});
