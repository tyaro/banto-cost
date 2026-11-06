/** Real Svelte fixture: oversized errors remain readable without resizing the scrollport. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX } from './theme';

const prefix = '/__grid-error-fixture/';
const requireGrid = createRequire(
	new URL('../../packages/grid-svelte/package.json', import.meta.url)
);
const themeCss = readFileSync(
	new URL('../../packages/theme/src/css/banto.css', import.meta.url),
	'utf8'
).replace(
	"@import './banto-glass.css';",
	readFileSync(new URL('../../packages/theme/src/css/banto-glass.css', import.meta.url), 'utf8')
);
let bundleDir: string;

test.beforeAll(async () => {
	bundleDir = mkdtempSync(path.join(tmpdir(), 'banto-grid-error-'));
	// Use the grid's existing dev dependency, without adding a root/runtime dependency.
	const { build } = await import(pathToFileURL(requireGrid.resolve('vite')).href);
	await build({
		configFile: fileURLToPath(
			new URL(
				'../../packages/grid-svelte/tests/browser/error-panel/vite.config.mjs',
				import.meta.url
			)
		),
		build: { outDir: bundleDir, emptyOutDir: true },
		logLevel: 'warn'
	});
});
test.afterAll(() => {
	if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

async function start(page: Page, locale: string, mode: string, index: number) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	const header = locale === 'ja' ? 'メモ' : 'Notes';
	const error =
		(locale === 'ja' ? '入力内容を確認してください。' : 'Please check the entered value. ').repeat(
			16
		) +
		'VeryLongErrorWithoutSpaces'.repeat(12) +
		' END-OF-ERROR';
	await page.route(`**${prefix}**`, async (route) => {
		const relative =
			decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length)) ||
			'index.html';
		const filename = path.resolve(bundleDir, relative);
		if (!filename.startsWith(`${bundleDir}${path.sep}`)) return route.abort();
		await route.fulfill({
			path: filename,
			contentType: filename.endsWith('.js')
				? 'application/javascript'
				: filename.endsWith('.css')
					? 'text/css'
					: 'text/html'
		});
	});
	await page.addInitScript(
		(settings) => {
			Object.assign(window, { gridErrorFixture: settings });
		},
		{
			mode,
			header,
			error,
			errorLabel: copy['grid.inlineEditErrorLabel'],
			errorHint: copy['grid.inlineEditErrorHint']
		}
	);
	await page.goto(prefix);
	await page.addStyleTag({ content: themeCss });
	await page.evaluate(
		({ combo, locale }) => {
			document.documentElement.lang = locale;
			document.documentElement.dataset.theme = combo.theme;
			document.documentElement.dataset.bantoPreset = combo.preset;
		},
		{ combo: DIAGONAL_MATRIX[index], locale }
	);
	return {
		copy,
		header,
		error,
		first: page.getByRole('region', { name: 'First grid', exact: true }),
		second: page.getByRole('region', { name: 'Second grid', exact: true })
	};
}

async function metrics(grid: Locator) {
	return grid.evaluate((el) => ({
		width: el.clientWidth,
		height: el.clientHeight,
		scrollWidth: el.scrollWidth,
		scrollHeight: el.scrollHeight,
		x: el.scrollLeft,
		y: el.scrollTop
	}));
}
async function expectPanelWithinGrid(panel: Locator, grid: Locator) {
	await expect(panel).toBeVisible();
	await expect
		.poll(async () => {
			const p = await panel.boundingBox();
			const g = await grid.boundingBox();
			return (
				!!p &&
				!!g &&
				p.x >= g.x - 1 &&
				p.y >= g.y - 1 &&
				p.x + p.width <= g.x + g.width + 1 &&
				p.y + p.height <= g.y + g.height + 1
			);
		})
		.toBe(true);
	expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

for (const [index, locale] of ['ja', 'en'].entries())
	for (const mode of ['client', 'server']) {
		test(`long errors wrap, scroll with keys and return to the editor (${locale}, ${mode})`, async ({
			page
		}, testInfo) => {
			await page.setViewportSize({ width: 320, height: 900 });
			const { copy, header, error, first } = await start(page, locale, mode, index);
			const grid = first.getByRole('grid');
			await grid.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
				el.scrollLeft = el.scrollWidth;
			});
			const cell = grid.locator('[data-cell-row="29"][data-cell-field="notes"]');
			await cell.dblclick();
			const editor = grid.getByRole('textbox', { name: header, exact: true });
			await editor.fill('invalid');
			await editor.evaluate((el) => {
				el.dataset.errorIdentity = 'original';
			});
			const before = await metrics(grid);
			await editor.press('Enter');
			const messageId = await editor.getAttribute('aria-describedby');
			expect(messageId).toBeTruthy();
			const message = page.getByRole('alert');
			await expect(message).toHaveAttribute('id', messageId!);
			await expect(message).toHaveText(error);
			await expect(editor).toHaveAccessibleDescription(error);
			const panel = first.getByRole('region', {
				name: copy['grid.inlineEditErrorLabel'].replace('{header}', header),
				exact: true
			});
			await expectPanelWithinGrid(panel, grid);
			await expect(editor).toBeFocused();
			expect(await metrics(grid)).toEqual(before);
			await expect(editor).toHaveAttribute('data-error-identity', 'original');
			await expect(page.getByLabel('Save calls')).toHaveText('0');

			await editor.press('Tab');
			await expect(panel).toBeFocused();
			await expect(panel).toHaveCSS('outline-style', 'solid');
			await panel.press('End');
			await expect
				.poll(() => panel.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1))
				.toBe(true);
			await panel.press('Home');
			await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBe(0);
			await panel.press('PageDown');
			await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
			await page.screenshot({ path: testInfo.outputPath('long-error-narrow.png') });
			await panel.press('Escape');
			await expect(editor).toBeFocused();
			await expect(editor).toHaveValue('invalid');
			await editor.press('Tab');
			await panel.press('Shift+Tab');
			await expect(editor).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('0');
			await editor.press('Tab');
			await panel.press('Tab');
			await expect(
				page.getByRole('button', { name: 'After first grid', exact: true })
			).toBeFocused();
			await expect(message).toHaveText(error);

			await page.setViewportSize({ width: 480, height: 1000 });
			await page.evaluate(() => {
				document.documentElement.style.fontSize = '200%';
			});
			await expectPanelWithinGrid(panel, grid);
			await editor.focus();
			await editor.press('Tab');
			await expect(panel).toBeFocused();
			await page.emulateMedia({ forcedColors: 'active' });
			await expect(panel).toHaveCSS('outline-style', 'solid');
			await panel.press('End');
			await expect
				.poll(() => panel.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1))
				.toBe(true);
			await page.emulateMedia({ forcedColors: 'none' });
			await panel.press('Escape');
			await editor.fill('Corrected');
			// Existing errors use Enter for explicit retry even after correcting input.
			await editor.press('Tab');
			await expect(panel).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('0');
			await panel.press('Escape');
			await editor.press('Enter');
			await expect(message).toHaveCount(0);
			await expect(panel).toHaveCount(0);
			await expect(page.getByLabel('Save calls')).toHaveText('1');
			await expect(grid).toBeFocused();
		});

		test(`API failure is read without retry; pending failure respects outside focus (${locale}, ${mode})`, async ({
			page
		}) => {
			const { copy, header, first, second } = await start(page, locale, mode, index);
			await page.getByLabel('Save behavior').selectOption('reject');
			const grid = first.getByRole('grid');
			const cell = grid.locator('[data-cell-row="0"][data-cell-field="notes"]');
			await cell.dblclick();
			const editor = grid.getByRole('textbox', { name: header, exact: true });
			await editor.fill('Changed');
			await editor.press('Enter');
			const panel = first.getByRole('region', {
				name: copy['grid.inlineEditErrorLabel'].replace('{header}', header),
				exact: true
			});
			await expectPanelWithinGrid(panel, grid);
			await panel.click({ position: { x: 10, y: 10 } });
			await expect(panel).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('1');
			await panel.press('Shift+Tab');
			await editor.press('Tab');
			await expect(panel).toBeFocused();
			await panel.press('Shift+Tab');
			await expect(editor).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('1');
			await editor.press('Escape');
			await expect(panel).toHaveCount(0);
			await page.getByLabel('Save behavior').selectOption('defer');
			await cell.dblclick();
			await editor.fill('Deferred');
			await editor.press('Tab');
			await expect(cell).toHaveAttribute('aria-busy', 'true');
			await page.getByRole('button', { name: 'After first grid', exact: true }).click();
			await page.locator('#reject-save').evaluate((el: HTMLButtonElement) => el.click());
			await expect(panel).toBeVisible();
			await expect(
				page.getByRole('button', { name: 'After first grid', exact: true })
			).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('2');

			await second
				.getByRole('grid')
				.locator('[data-cell-row="0"][data-cell-field="notes"]')
				.dblclick();
			const otherEditor = second.getByRole('textbox', { name: header, exact: true });
			await otherEditor.fill('invalid');
			await otherEditor.press('Enter');
			const messages = page.getByRole('alert');
			await expect(messages).toHaveCount(2);
			const ids = await messages.evaluateAll((elements) => elements.map((el) => el.id));
			expect(new Set(ids).size).toBe(2);
			await expect(otherEditor).toHaveAccessibleDescription(await messages.last().innerText());
			await otherEditor.press('Tab');
			const otherPanel = second.getByRole('region', {
				name: copy['grid.inlineEditErrorLabel'].replace('{header}', header),
				exact: true
			});
			await expect(otherPanel).toBeFocused();
			const scan = await new AxeBuilder({ page })
				.include('.banto-grid-frame')
				.withTags(['wcag2a', 'wcag2aa'])
				.analyze();
			expect(scan.violations).toEqual([]);
			await otherPanel.press('Escape');
			await otherEditor.press('Escape');
			await expect(messages).toHaveCount(1);
		});

		test(`nested clipping and virtualized disappearance keep error identity and outside focus (${locale}, ${mode})`, async ({
			page
		}) => {
			await page.setViewportSize({ width: 320, height: 900 });
			const { first } = await start(page, locale, mode, index);
			const grid = first.getByRole('grid');
			await first.evaluate((el) => {
				Object.assign((el as HTMLElement).style, { maxHeight: '200px', overflow: 'auto' });
			});
			const cell = grid.locator('[data-cell-row="0"][data-cell-field="name"]');
			await cell.dblclick();
			const editor = grid.getByRole('textbox', { name: 'Name', exact: true });
			await editor.fill('invalid');
			const before = await metrics(grid);
			await editor.press('Tab');
			const panel = first.locator('.cell-error-region');
			await expect(panel).toBeFocused();
			await expectPanelWithinGrid(panel, grid);
			const ancestorBottom = await first.evaluate(
				(el) => el.getBoundingClientRect().top + el.clientHeight
			);
			await expect
				.poll(async () => {
					const bounds = await panel.boundingBox();
					return !!bounds && bounds.y + bounds.height <= ancestorBottom + 1;
				})
				.toBe(true);
			expect(await metrics(grid)).toEqual(before);
			await panel.evaluate((el) => {
				el.dataset.errorIdentity = 'same';
			});
			await first.evaluate((el) => {
				(el as HTMLElement).style.maxHeight = '180px';
			});
			await expect
				.poll(async () => {
					const p = await panel.boundingBox();
					const a = await first.evaluate((el) => el.getBoundingClientRect().top + el.clientHeight);
					return !!p && p.y + p.height <= a + 1;
				})
				.toBe(true);
			const outside = page.getByRole('button', { name: 'After first grid', exact: true });
			await outside.focus();
			await first.evaluate((el) => {
				(el as HTMLElement).style.maxHeight = '8px';
				const editor = el.querySelector('.cell-editor')!;
				el.scrollTop += editor.getBoundingClientRect().top - el.getBoundingClientRect().top;
			});
			await expect(panel).toBeVisible();
			await expect
				.poll(async () => {
					const p = await panel.boundingBox();
					const a = await first.boundingBox();
					return !!p && !!a && p.y >= a.y - 1 && p.y + p.height <= a.y + a.height + 1;
				})
				.toBe(true);
			await expect(outside).toBeFocused();
			await first.evaluate((el) => {
				(el as HTMLElement).style.maxHeight = '180px';
				el.scrollTop = 0;
			});
			await expectPanelWithinGrid(panel, grid);
			await grid.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			await expect(panel).toBeHidden();
			await grid.evaluate((el) => {
				el.scrollTop = 0;
			});
			await expect(panel).toBeVisible();
			await expect(panel).toHaveAttribute('data-error-identity', 'same');
			await expect(outside).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('0');
			await first.evaluate((el) => {
				(el as HTMLElement).style.removeProperty('max-height');
			});
			// Resizing a preceding column can move an unchanged-size editor offscreen.
			const resize = grid.getByRole('columnheader').first().getByRole('separator');
			const handle = await resize.boundingBox();
			expect(handle).toBeTruthy();
			await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
			await page.mouse.down();
			await page.mouse.move(handle!.x + 400, handle!.y + handle!.height / 2, { steps: 8 });
			await page.mouse.up();
			await expect(panel).toBeHidden();
			await resize.dblclick();
			await grid.evaluate((el) => {
				el.scrollLeft = 0;
			});
			await expect(panel).toBeVisible();
			await expect(panel).toHaveAttribute('data-error-identity', 'same');
			await editor.focus();
			await editor.press('Escape');
			await expect(panel).toHaveCount(0);
			await first.evaluate((el) => {
				(el as HTMLElement).style.removeProperty('max-height');
			});
			await grid.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
				el.scrollLeft = el.scrollWidth;
			});
			await grid.locator('[data-cell-row="29"][data-cell-field="notes"]').dblclick();
			const last = grid.locator('.cell-editor');
			await last.fill('invalid');
			await last.press('Enter');
			await expect(panel).toBeVisible();
			await page.getByRole('button', { name: 'Remove last row', exact: true }).click();
			await expect(panel).toHaveCount(0);
			await expect(last).toHaveCount(0);
			await expect(
				page.getByRole('button', { name: 'Remove last row', exact: true })
			).toBeFocused();
			await expect(page.getByLabel('Save calls')).toHaveText('0');
		});
	}
