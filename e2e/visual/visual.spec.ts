/**
 * Phase 0 visual regression (visual-refresh-plan.md Phase 0,
 * visual-refresh-design.md §12.1). Runs against the `visual` project's
 * `vite preview` server (browser demo mode, spec §11.1's third
 * environment - InMemory data seeded from the deterministic `sampleData.ts`
 * PRNG, fixed admin/admin auth) so screenshots never depend on a live
 * SQLite backend or wall-clock time.
 *
 * No `waitForLoadState('networkidle')` anywhere - demo mode has no SSE and
 * (per the project doc comment) no ongoing network traffic to go idle on.
 * Instead each test waits for a concrete visible element (the thing that
 * only appears once its data has actually rendered) plus a short, fixed
 * settle (`page.waitForTimeout`) for the layout/paint to finish - CSS
 * transitions are already zeroed by `reducedMotion: 'reduce'`
 * (banto.css §2.3), so this settle is purely for chart/dock layout math,
 * not animation.
 */
import { expect, test } from '@playwright/test';
import {
	DIAGONAL_MATRIX,
	FULL_MATRIX,
	VIEWPORTS,
	comboLabel,
	primeKiosk,
	primeLauncher,
	primeTheme,
	primeThemeAndAuth,
	type LauncherPosition,
	type ThemeCombo
} from './theme';

/** Chart/dock layout settle after the data-dependent element becomes visible. */
const SETTLE_MS = 300;

test.describe('login', () => {
	for (const combo of FULL_MATRIX) {
		for (const viewport of VIEWPORTS) {
			const label = `${comboLabel(combo)} ${viewport.width}x${viewport.height}`;
			test(`login ${label}`, async ({ page }) => {
				await page.setViewportSize(viewport);
				await primeTheme(page, combo);
				await page.goto('/login');
				await expect(page.getByRole('heading', { name: 'Banto Cost' })).toBeVisible();
				await expect(page.getByLabel('ユーザー名')).toBeVisible();
				await page.waitForTimeout(SETTLE_MS);
				await expect(page).toHaveScreenshot(
					`login-${comboLabel(combo)}-${viewport.width}x${viewport.height}.png`,
					{
						fullPage: true
					}
				);
			});
		}
	}
});

test.describe('dashboard', () => {
	for (const combo of FULL_MATRIX) {
		for (const viewport of VIEWPORTS) {
			const label = `${comboLabel(combo)} ${viewport.width}x${viewport.height}`;
			test(`dashboard ${label}`, async ({ page }) => {
				await page.setViewportSize(viewport);
				await primeThemeAndAuth(page, combo);
				await page.goto('/dashboard');
				await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
				// Charts/KPIs render once the 10k-row seeded dataset finishes
				// loading (createListResource) - wait for a chart's <svg> instead
				// of a network signal (demo mode has no network round trip at all).
				await expect(page.locator('[data-tile]').first()).toBeVisible();
				await page.waitForTimeout(SETTLE_MS);
				await expect(page).toHaveScreenshot(
					`dashboard-${comboLabel(combo)}-${viewport.width}x${viewport.height}.png`,
					{ fullPage: true }
				);
			});
		}
	}
});

// Kiosk shell (display-preset-plan.md D1-b): one screenshot, not the full
// matrix - this only proves the ON state renders (collapsed sidebar,
// compact header, no search pill, fullscreen button) at the baseline
// viewport; the default-OFF path is already covered by every other test in
// this file (none of them prime the kiosk key, so they stay byte-for-byte
// unaffected by this unit per display-preset-plan.md's design principle).
test.describe('kiosk shell', () => {
	test('dashboard kiosk light-standard 1440x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await primeKiosk(page);
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('[data-tile]').first()).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('dashboard-kiosk-light-standard-1440x900.png', {
			fullPage: true
		});
	});
});

// Dock layout (nav-launcher-plan.md §7.3): the diagonal at the baseline
// viewport plus the <=900px tab bar, and one shot per other edge (D4, one
// combo each). Primed like the kiosk shell, so every other test here keeps
// the default sidebar.
const LAUNCHER_SHOTS: {
	combo: ThemeCombo;
	viewport: { width: number; height: number };
	position: LauncherPosition;
}[] = [
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 1440, height: 900 }, position: 'bottom' },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 }, position: 'bottom' },
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 768, height: 1024 }, position: 'bottom' },
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 1440, height: 900 }, position: 'left' },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 }, position: 'right' },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 }, position: 'top' }
];

test.describe('dock layout', () => {
	for (const { combo, viewport, position } of LAUNCHER_SHOTS) {
		const size = `${viewport.width}x${viewport.height}`;
		// The bottom bar keeps its original names (existing baselines).
		const side = position === 'bottom' ? '' : `${position}-`;
		test(`dashboard launcher ${side}${comboLabel(combo)} ${size}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await primeThemeAndAuth(page, combo);
			await primeLauncher(page, position);
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(page.locator('[data-tile]').first()).toBeVisible();
			await expect(page.locator('.launcher')).toBeVisible();
			// Viewport shot scrolled to the end, not fullPage: a full-page capture
			// draws the fixed bar at the first viewport's bottom - mid-page - so it
			// would show neither where the dock sits nor that the page's last
			// content clears it (the shell's bottom reserve, plan §4.1).
			// The charts lay out after first paint (the page is one viewport tall
			// until then), so settle first, scroll, and wait until it really moved.
			// A top bar keeps the page start instead: that is where the shell's
			// top reserve shows (the content starts below the bar).
			await page.waitForTimeout(SETTLE_MS);
			if (position !== 'top') {
				await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				// banto-cost's dashboard can fit the viewport (no scroll then).
				const scrollable = await page.evaluate(
					() => document.documentElement.scrollHeight > window.innerHeight
				);
				if (scrollable) {
					await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
				}
				await page.waitForTimeout(SETTLE_MS);
			}
			await expect(page).toHaveScreenshot(
				`dashboard-launcher-${side}${comboLabel(combo)}-${size}.png`
			);
		});
	}
});

interface DiagonalPage {
	name: string;
	path: string;
	heading: string;
}

// Plan Phase 0's thinning rule: everything except login/dashboard only
// shoots the diagonal (light/standard, dark/glass) at the one baseline
// viewport (1440x900).
const DIAGONAL_PAGES: DiagonalPage[] = [
	{ name: 'customers', path: '/customers', heading: '顧客' },
	{ name: 'projects', path: '/projects', heading: '案件台帳' },
	{ name: 'users', path: '/users', heading: 'ユーザー管理' },
	// settings-routes step 2 (choiapp-feedback-2026-09 §3.2): each category
	// is now its own route, so no single settings screenshot shows all of
	// them anymore - `/settings` (lands on appearance) plus one more
	// category per visibility tier (account: always visible; connectivity:
	// admin-only, but visible in this demo-mode admin session too).
	{ name: 'settings', path: '/settings', heading: '設定' },
	{ name: 'settings-account', path: '/settings/account', heading: '設定' },
	{ name: 'settings-connectivity', path: '/settings/connectivity', heading: '設定' },
	// @banto/ui catalog page (Issue #220 / ADR-0018 §6). Reached by URL: its
	// sidebar entry is demo-build-only (`demoOnly`), and this suite builds
	// without VITE_BANTO_DEMO, so the shared sidebar baselines stay unchanged.
	{ name: 'ui-demo', path: '/ui-demo', heading: 'UI 部品の見本' }
];

test.describe('diagonal pages', () => {
	for (const combo of DIAGONAL_MATRIX) {
		for (const p of DIAGONAL_PAGES) {
			test(`${p.name} ${comboLabel(combo)} 1440x900`, async ({ page }) => {
				await primeThemeAndAuth(page, combo);
				await page.goto(p.path);
				await expect(page.getByRole('heading', { name: p.heading })).toBeVisible();
				await page.waitForTimeout(SETTLE_MS);
				await expect(page).toHaveScreenshot(`${p.name}-${comboLabel(combo)}-1440x900.png`, {
					fullPage: true
				});
			});
		}
	}
});

test.describe('command palette', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`command-palette ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await primeThemeAndAuth(page, combo);
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await page.keyboard.press('Control+K');
			await expect(page.getByRole('dialog', { name: 'コマンドパレット' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`command-palette-${comboLabel(combo)}-1440x900.png`, {
				fullPage: true
			});
		});
	}
});

// @banto/ui DateInput with its calendar open (date-time-pickers §6, PR-1). The
// clock is pinned so the "today" ring (aria-current) is the same on every
// run; the selected day (the sample's fixed value) is a different day, so both
// states show. Viewport shot (not fullPage): the popover is in the top layer
// beside the field, and the closed card is already in the ui-demo baseline.
test.describe('date picker', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-date-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const opener = page.getByRole('button', { name: '日付を変更、2026年11月7日土曜日' });
			await opener.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await opener.click();
			await expect(page.getByRole('dialog', { name: '日付の選択' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`ui-demo-date-picker-${comboLabel(combo)}-1440x900.png`);
		});
	}
});

// @banto/ui TimeInput with its list open (date-time-pickers §6, PR-2): the
// sample's fixed value (09:30) is the active option, centred in the list.
// Opened from the keyboard so no pointer hovers an option. Viewport shot, like
// the date picker above.
test.describe('time picker', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-time-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const input = page.getByRole('combobox', { name: '開始時刻' });
			await input.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await input.focus();
			await page.keyboard.press('ArrowDown');
			await expect(page.getByRole('listbox', { name: '時刻の一覧' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`ui-demo-time-picker-${comboLabel(combo)}-1440x900.png`);
		});
	}
});

// @banto/ui DateTimeInput with its dialog open (date-time-pickers §6, PR-5): the
// calendar and the time list side by side, on the sample's fixed value
// (2026-11-07 09:30, the active time centred in the list). The clock is pinned
// like the date picker's. Viewport shot, like the pickers above.
test.describe('date-time picker', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-datetime-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const opener = page.getByRole('button', {
				name: '日時を変更、2026年11月7日土曜日 09:30'
			});
			await opener.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await opener.click();
			await expect(page.getByRole('dialog', { name: '日時の選択' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(
				`ui-demo-datetime-picker-${comboLabel(combo)}-1440x900.png`
			);
		});
	}
});
