/**
 * The device side of the LAN reach check (Issue #219 stage 1 / PR-C3,
 * lan-reach-check-design §4.3, D2): `/reach#t=<token>` served by banto-serve
 * (outside the `(app)` auth guard, no login), with `POST /api/reach-check`
 * stubbed - banto-serve itself does not mount the route (design §5.2: only
 * the desktop's embedded server, which can issue, does).
 *
 * What it pins down: the token is taken from the fragment and removed from
 * the address bar, then sent with the CSRF header and nothing else; the
 * result code becomes the page's text; without a token nothing is sent.
 *
 * Runs in its own page/context - independent of smoke.spec.ts's shared state.
 */
import { expect, test, type Request } from '@playwright/test';

const TOKEN = '0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f';

test.describe('/reach (device side of the LAN reach check)', () => {
	test('sends the token from the fragment, removes it from the URL and shows the result', async ({
		page
	}) => {
		const requests: Request[] = [];
		await page.route('**/api/reach-check', async (route) => {
			requests.push(route.request());
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ result: 'recorded' })
			});
		});
		await page.goto(`/reach#t=${TOKEN}`);

		await expect(page.getByRole('heading', { name: '接続の確認' })).toBeVisible();
		await expect(page.locator('[data-reach="recorded"]')).toContainText(
			'この端末からの接続を記録しました。'
		);
		expect(new URL(page.url()).hash).toBe('');
		expect(new URL(page.url()).pathname).toBe('/reach');
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.method()).toBe('POST');
		expect(request.headers()['x-banto-client']).toBe('banto');
		expect(request.headers()['authorization']).toBeUndefined();
		expect(request.postDataJSON()).toEqual({ token: TOKEN });
		// No login screen, no app navigation.
		await expect(page.getByRole('navigation')).toHaveCount(0);
	});

	test('maps an unusable answer, and sends nothing without a token', async ({ page }) => {
		let sent = 0;
		await page.route('**/api/reach-check', async (route) => {
			sent++;
			await route.fulfill({
				status: 404,
				contentType: 'application/json',
				body: JSON.stringify({ result: 'unusable' })
			});
		});
		await page.goto(`/reach#t=${TOKEN}`);
		await expect(page.locator('[data-reach="unusable"]')).toContainText('使えない URL です');
		expect(sent).toBe(1);

		// A full load (not a same-document hash change).
		await page.goto('about:blank');
		await page.goto('/reach#t=not-a-token');
		await expect(page.locator('[data-reach="noToken"]')).toContainText('使えない URL です');
		expect(new URL(page.url()).hash).toBe('');
		expect(sent).toBe(1);
	});

	test('works while the startup probe (/api/auth/check) is slow or failing', async ({ page }) => {
		// The app's startup never finishes here: the probe hangs, then fails.
		let releaseProbe: () => void = () => {};
		const probeHeld = new Promise<void>((resolve) => (releaseProbe = resolve));
		await page.route('**/api/auth/check', async (route) => {
			await probeHeld;
			await route.abort('failed');
		});
		await page.route('**/api/reach-check', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ result: 'recorded' })
			});
		});
		await page.goto(`/reach#t=${TOKEN}`);
		await expect(page.locator('[data-reach="recorded"]')).toContainText(
			'この端末からの接続を記録しました。'
		);
		expect(new URL(page.url()).hash).toBe('');
		releaseProbe();
		// Still the result, not the startup splash.
		await expect(page.locator('[data-reach="recorded"]')).toBeVisible();
	});

	test('a new check URL opened in the same tab is sent again, and the old answer never wins', async ({
		page
	}) => {
		const SECOND = '1e9c3f5a-2d4b-4c6e-8f7a-8b9cad0e1f30';
		const THIRD = '2fad4a6b-3e5c-4d7f-9a8b-9cadbe1f2a41';
		const sent: string[] = [];
		let releaseSecond: () => void = () => {};
		const secondHeld = new Promise<void>((resolve) => (releaseSecond = resolve));
		await page.route('**/api/reach-check', async (route) => {
			const { token } = route.request().postDataJSON() as { token: string };
			sent.push(token);
			if (token === SECOND) await secondHeld;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ result: token === THIRD ? 'unusable' : 'recorded' })
			});
		});
		await page.goto(`/reach#t=${TOKEN}`);
		await expect(page.locator('[data-reach="recorded"]')).toBeVisible();

		// Same document, no about:blank in between: only the fragment changes.
		await page.evaluate((token) => (window.location.hash = `t=${token}`), SECOND);
		await expect(page.locator('[data-reach="checking"]')).toBeVisible();
		await expect.poll(() => new URL(page.url()).hash).toBe('');
		await page.evaluate((token) => (window.location.hash = `t=${token}`), THIRD);
		await expect(page.locator('[data-reach="unusable"]')).toBeVisible();
		expect(new URL(page.url()).hash).toBe('');

		// The answer for the second URL arrives last: it must not replace the third's.
		releaseSecond();
		await expect.poll(() => sent).toEqual([TOKEN, SECOND, THIRD]);
		await page.waitForTimeout(200);
		await expect(page.locator('[data-reach="unusable"]')).toBeVisible();
		await expect(page.locator('[data-reach="checking"]')).toHaveCount(0);
	});
});
