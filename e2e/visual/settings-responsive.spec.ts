/** Exercise every desktop settings category with loaded IPC data at narrow widths and text enlargement. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
	installSettingsLayoutStub,
	serveOnTauriOrigin,
	tauriUrl
} from '../tests/tauri-settings-fixture';
import { DIAGONAL_MATRIX, primeTheme } from './theme';

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	for (const width of [320, 1440]) {
		test(`desktop settings fit at ${width}px and 200% text (${locale})`, async ({
			page,
			baseURL
		}) => {
			test.setTimeout(90_000);
			await page.setViewportSize({ width, height: 900 });
			await installSettingsLayoutStub(page);
			await primeTheme(page, DIAGONAL_MATRIX[index]);
			await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
			await serveOnTauriOrigin(page, baseURL);
			for (const scale of [1, 2]) {
				for (const category of ['appearance', 'account', 'connectivity', 'data', 'security']) {
					await page.goto(tauriUrl(`/settings/${category}`));
					await expect(page.locator('.settings-grid .surface-card').first()).toBeVisible();
					await expect(
						page
							.getByRole('navigation', { name: copy['settings.sectionNavAria'] })
							.getByRole('link')
					).toHaveCount(5);
					if (category === 'connectivity')
						await expect(page.getByLabel(copy['settings.port'])).toBeEnabled();
					if (category === 'data')
						await expect(page.getByLabel(copy['settings.retentionDays'])).toHaveValue('90');
					if (scale === 2)
						await page.evaluate(() => {
							document.documentElement.style.fontSize = `${parseFloat(getComputedStyle(document.documentElement).fontSize) * 2}px`;
						});
					await expect
						.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth), {
							message: `${locale}/${width}/${scale}/${category}: horizontal overflow`
						})
						.toBeLessThanOrEqual(1);
					for (const control of await page.locator('.settings-page .banto-field-control').all()) {
						if (await control.isEnabled()) await control.focus();
						const label = await control.evaluate(
							(element) => element.nextElementSibling!.textContent
						);
						const gap = await control.evaluate(
							(element) =>
								element.getBoundingClientRect().top +
								parseFloat(getComputedStyle(element).paddingTop) -
								element.nextElementSibling!.getBoundingClientRect().bottom
						);
						expect(
							gap,
							`${locale}/${width}/${scale}/${category}/${label}: label must clear the input value`
						).toBeGreaterThanOrEqual(-1);
						await control.blur();
					}
					for (const button of await page.locator('.settings-page .banto-btn').all()) {
						if (!(await button.isVisible())) continue;
						expect(
							await button.evaluate((element) => ({
								width: element.scrollWidth <= element.clientWidth + 1,
								height: element.scrollHeight <= element.clientHeight + 1
							})),
							`${locale}/${width}/${scale}/${category}: action text must fit`
						).toEqual({ width: true, height: true });
					}
					await expect(page.getByText(copy['unsaved.notice'], { exact: true })).toHaveCount(0);
				}
			}
		});
	}
}
