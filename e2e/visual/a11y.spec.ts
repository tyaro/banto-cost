/**
 * Phase 0 / §7.1 axe-core accessibility scan (visual-refresh-plan.md §7.1,
 * visual-refresh-design.md §12.2). Same `visual` project (vite preview,
 * browser demo mode) and theme-priming helpers as visual.spec.ts, but
 * asserting on `axe-core` violations instead of pixels.
 *
 * Scope: dashboard / customers / settings / login, each scanned once per the
 * diagonal matrix (light/standard, dark/glass) - contrast is theme-
 * dependent, so both ends of the matrix must be checked; wcag2a/wcag2aa
 * violations that are NOT contrast (roles, labels, ...) are theme-
 * independent but cheap enough to just re-check anyway rather than special
 * -case them.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, comboLabel, primeLauncher, primeTheme, primeThemeAndAuth } from './theme';

interface ScannedPage {
	name: string;
	path: string;
	heading: string;
	/** Protected (app) route vs. the public login screen. */
	authed: boolean;
}

const PAGES: ScannedPage[] = [
	{ name: 'dashboard', path: '/dashboard', heading: 'ダッシュボード', authed: true },
	{ name: 'customers', path: '/customers', heading: '顧客', authed: true },
	// settings-routes step 2 (choiapp-feedback-2026-09 §3.2): categories are
	// now separate routes, so axe scans each one individually instead of
	// relying on a single page showing everything at once.
	{ name: 'settings', path: '/settings', heading: '設定', authed: true },
	{ name: 'settings-account', path: '/settings/account', heading: '設定', authed: true },
	{ name: 'settings-connectivity', path: '/settings/connectivity', heading: '設定', authed: true },
	{ name: 'login', path: '/login', heading: 'Banto Cost', authed: false }
];

/** Readable failure message: rule id + impact + affected node selectors, so a CI failure is actionable without opening the HTML report. */
function formatViolations(violations: import('axe-core').Result[]): string {
	return violations
		.map((v) => {
			const nodes = v.nodes.map((n) => `    - ${n.target.join(' ')}`).join('\n');
			return `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n${nodes}`;
		})
		.join('\n\n');
}

async function gotoScanned(page: Page, target: ScannedPage): Promise<void> {
	await page.goto(target.path);
	await expect(page.getByRole('heading', { name: target.heading })).toBeVisible();
	// Chart-heavy pages (dashboard) render async off the seeded dataset -
	// same rationale as visual.spec.ts: wait for a concrete element, not a
	// network signal.
	if (target.name === 'dashboard') {
		await expect(page.locator('svg').first()).toBeVisible();
	}
}

for (const combo of DIAGONAL_MATRIX) {
	test.describe(`a11y ${comboLabel(combo)}`, () => {
		for (const target of PAGES) {
			test(`${target.name} has no wcag2a/wcag2aa violations`, async ({ page }) => {
				if (target.authed) {
					await primeThemeAndAuth(page, combo);
				} else {
					await primeTheme(page, combo);
				}
				await gotoScanned(page, target);

				const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

				expect(results.violations, formatViolations(results.violations)).toEqual([]);
			});
		}
	});
}

// Dock layout (nav-launcher-plan.md §4.8/§7.3): the shell's other navigation.
for (const combo of DIAGONAL_MATRIX) {
	test(`a11y ${comboLabel(combo)} dashboard with the dock has no wcag2a/wcag2aa violations`, async ({
		page
	}) => {
		await primeThemeAndAuth(page, combo);
		await primeLauncher(page);
		await gotoScanned(page, PAGES[0]);
		await expect(page.locator('.launcher')).toBeVisible();

		const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

		expect(results.violations, formatViolations(results.violations)).toEqual([]);
	});
}

// A vertical dock (D4): one side and one combo - the same markup as the
// bottom bar, but the tooltips, the active dot and the separator move.
test(`a11y ${comboLabel(DIAGONAL_MATRIX[1])} dashboard with a left dock has no wcag2a/wcag2aa violations`, async ({
	page
}) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[1]);
	await primeLauncher(page, 'left');
	await gotoScanned(page, PAGES[0]);
	await expect(page.locator('.launcher--left')).toBeVisible();

	const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

	expect(results.violations, formatViolations(results.violations)).toEqual([]);
});
