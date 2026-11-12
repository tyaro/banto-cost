/**
 * Date / time pickers at a 320px-wide viewport with the root text size at
 * 200% (date-time-pickers.md §5.2, the same check items as ADR-0026): the
 * ui-demo page's DateInput, TimeInput, DateTimeInput and DateRangeInput.
 * Judged by numbers, not screenshots (no baseline images): the page does not
 * scroll sideways at 320px (at 200% the demo page's other cards - long words
 * in headings, the grid card - overflow on their own, so there the check is
 * scoped to the picker's own box), the open popover sits inside the viewport and its content
 * stays inside it horizontally, and every field's text box and button do not
 * overlap. Same `visual` project as the other specs here (vite preview,
 * browser demo mode, reduced motion).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

const VIEWPORT = { width: 320, height: 700 };

interface Case {
	name: string;
	field: (page: Page) => Locator;
	key: 'Alt+ArrowDown' | 'ArrowDown';
	popup: (page: Page) => Locator;
}

const cases: Case[] = [
	{
		name: 'DateInput',
		field: (page) => page.getByRole('textbox', { name: '納期' }),
		key: 'Alt+ArrowDown',
		popup: (page) => page.getByRole('dialog', { name: '日付の選択' })
	},
	{
		name: 'TimeInput',
		field: (page) => page.getByRole('combobox', { name: '開始時刻' }),
		key: 'ArrowDown',
		popup: (page) => page.getByRole('listbox', { name: '時刻の一覧' })
	},
	{
		name: 'DateTimeInput',
		field: (page) => page.getByRole('textbox', { name: '開始日時' }),
		key: 'Alt+ArrowDown',
		popup: (page) => page.getByRole('dialog', { name: '日時の選択' })
	},
	{
		name: 'DateRangeInput',
		field: (page) => page.locator('#ui-demo-stay').getByRole('textbox', { name: '開始日' }),
		key: 'Alt+ArrowDown',
		popup: (page) => page.getByRole('dialog', { name: '日付の選択' })
	}
];

for (const c of cases) {
	test(`${c.name} fits a 320px viewport at 200% text`, async ({ page }) => {
		await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.setViewportSize(VIEWPORT);
		await page.goto('/ui-demo');
		await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
		const sideways = () =>
			page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
		expect(await sideways()).toBe(true);
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));

		const field = c.field(page);
		const popup = c.popup(page);
		await field.scrollIntoViewIfNeeded();

		// Closed: no sideways scroll, and the text box does not run under its button.
		const overlaps = await field.evaluate((input) => {
			const wrap = input.closest('.date-input-field, .time-input-field, .datetime-input-field');
			const button = wrap?.querySelector('button');
			if (!wrap || !button) return { found: false, gap: 0, inside: false };
			const a = input.getBoundingClientRect();
			const b = button.getBoundingClientRect();
			const w = wrap.getBoundingClientRect();
			return {
				found: true,
				gap: b.left - a.right,
				inside: b.right <= w.right + 1 && b.left >= w.left - 1 && a.left >= w.left - 1
			};
		});
		expect(overlaps.found).toBe(true);
		expect(overlaps.gap).toBeGreaterThanOrEqual(-1);
		expect(overlaps.inside).toBe(true);
		const own = await field.evaluate((input) => {
			const root = input.closest('.date-range-input, .date-input, .time-input, .datetime-input');
			const r = root?.getBoundingClientRect();
			return {
				found: !!root,
				right: r?.right ?? 0,
				overflow: root ? root.scrollWidth - root.clientWidth : 0
			};
		});
		expect(own.found).toBe(true);
		expect(own.right).toBeLessThanOrEqual(VIEWPORT.width);
		expect(own.overflow).toBeLessThanOrEqual(1);

		// A key pressed before hydration is lost: retry the open until it shows.
		await expect(async () => {
			await field.focus();
			await page.keyboard.press(c.key);
			await expect(popup).toBeVisible({ timeout: 1000 });
		}).toPass();

		const box = await popup.boundingBox();
		expect(box).not.toBeNull();
		if (box) {
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width);
			expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height);
		}
		// Content stays inside the popover horizontally (calendar cells, footer
		// buttons, time options); the time list scrolls vertically only.
		const stray = await popup.evaluate((el) => {
			const outer = el.getBoundingClientRect();
			const bad: string[] = [];
			for (const child of el.querySelectorAll('*')) {
				const r = child.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) continue;
				if (r.left < outer.left - 1 || r.right > outer.right + 1) {
					bad.push(
						`${child.tagName}.${child.className} ${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(outer.left)}-${Math.round(outer.right)}`
					);
				}
			}
			return { bad, overflow: el.scrollWidth - el.clientWidth };
		});
		expect(stray.bad).toEqual([]);
		expect(stray.overflow).toBeLessThanOrEqual(1);
	});
}
