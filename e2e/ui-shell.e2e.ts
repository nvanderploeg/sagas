import { expect, live, test } from './fixtures/ui.ts';
import { getNoFollow } from './support/http.ts';

test.describe('theme', () => {
	test('is one radio group: one tab stop, arrow keys choose', async ({ page }) => {
		await page.goto('/');
		const group = page.getByRole('radiogroup', { name: 'Theme' });
		const radio = (name: string) => group.getByRole('radio', { name });
		await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
		await expect(radio('System')).toHaveAttribute('tabindex', '0');

		await radio('System').focus();
		await page.keyboard.press('ArrowRight');
		await expect(radio('Light')).toBeFocused();
		await expect(radio('Light')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.keyboard.press('ArrowDown');
		await expect(radio('Dark')).toBeFocused();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.keyboard.press('ArrowRight');
		await expect(radio('System')).toBeFocused();
		await expect(page.locator('html')).not.toHaveAttribute('data-theme');
		await page.keyboard.press('ArrowLeft');
		await expect(radio('Dark')).toBeFocused();
		await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
		await expect(radio('Dark')).toHaveAttribute('tabindex', '0');

		await page.keyboard.press('Tab');
		await expect(group.locator(':focus')).toHaveCount(0);
		await page.keyboard.press('Shift+Tab');
		await expect(radio('Dark')).toBeFocused();
	});
});

test.describe('content security policy', () => {
	test('pages carry it, and it lets the app and its theme script run', async ({ page, ui }) => {
		const p = ui.realm();
		const t = ui.labour(p.id, {
			title: 'Pictures',
			description: '![chart](https://tracker.example/pixel.png) and [a link](https://example.com)'
		});
		await page.addInitScript(() => {
			const blocked: string[] = [];
			(window as unknown as { blocked: string[] }).blocked = blocked;
			document.addEventListener('securitypolicyviolation', (e) =>
				blocked.push(`${e.violatedDirective} ${e.blockedURI}`)
			);
		});
		const tracked: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('tracker.example')) tracked.push(request.url());
		});

		const response = await page.goto(`/l/${t.key}`);
		const policy = response!.headers()['content-security-policy'];
		expect(policy).toContain("img-src 'self' data:");
		expect(policy).toContain("connect-src 'self'");
		expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
		expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
		await live(page);

		const body = page.getByTestId('markdown');
		await expect(body.locator('img')).toHaveCount(0);
		await expect(body.getByRole('link', { name: 'chart' })).toHaveAttribute(
			'href',
			'https://tracker.example/pixel.png'
		);
		await page.goto(`/r/${p.key}`);
		await live(page);
		await page.goto('/');
		await live(page);
		expect(await page.evaluate(() => (window as unknown as { blocked: string[] }).blocked)).toEqual(
			[]
		);
		expect(tracked).toEqual([]);
	});

	test('the theme script runs before the app does', async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('sagas-theme', 'dark'));
		await page.route('**/_app/**', (route) => route.abort());
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});

	test('leaves the Stream and /mcp alone', async ({ page, request }) => {
		const anonymous = await getNoFollow(request, '/api/events');
		expect(anonymous.status()).toBe(401);
		expect(anonymous.headers()['content-security-policy']).toBeUndefined();
		const mcp = await request.post('/mcp', { data: {}, maxRedirects: 0 });
		expect(mcp.status()).toBe(401);
		expect(mcp.headers()['content-security-policy']).toBeUndefined();

		await page.goto('/');
		const stream = await page.evaluate(async () => {
			const abort = new AbortController();
			const response = await fetch('/api/events', { signal: abort.signal });
			abort.abort();
			return { status: response.status, csp: response.headers.get('content-security-policy') };
		});
		expect(stream).toEqual({ status: 200, csp: null });
	});
});

test.describe('session', () => {
	test('a Stream refused for a lost session sends the user to sign in, then back', async ({
		other,
		ui
	}) => {
		const p = ui.realm();
		const { page, context, person } = other;
		await page.goto(`/r/${p.key}?filter=1`);
		await live(page);

		const tab = await context.newPage();
		await tab.goto('/account');
		await tab.getByRole('button', { name: 'Sign out' }).click();
		await expect(tab).toHaveURL(/\/login$/);
		await tab.close();

		const back = encodeURIComponent(`/r/${p.key}?filter=1`);
		await expect(page).toHaveURL(new RegExp(`/login\\?next=${back}$`), { timeout: 10_000 });
		await page.getByLabel('Username').fill(person.username);
		await page.getByLabel('Password').fill(person.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}\\?filter=1$`));
		await live(page);
	});

	test('signing in never follows a return path off the site', async ({ other }) => {
		const { page, context, person } = other;
		await context.clearCookies();
		for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
			await page.goto(`/login?next=${encodeURIComponent(next)}`);
			await page.getByLabel('Username').fill(person.username);
			await page.getByLabel('Password').fill(person.password);
			await page.getByRole('button', { name: 'Sign in' }).click();
			await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
			await context.clearCookies();
		}
	});
});

test.describe('dashboard', () => {
	test('a long list of open Labours shows about 20 and scrolls the rest', async ({ page, ui }) => {
		const p = ui.realm();
		for (let i = 0; i < 30; i++) ui.labour(p.id, { title: `Mine ${i}` });
		await page.goto('/');

		const list = page.getByTestId('mine');
		const { client, scroll, row } = await list.evaluate((el) => ({
			client: el.clientHeight,
			scroll: el.scrollHeight,
			row: el.querySelector('li')!.getBoundingClientRect().height
		}));
		expect(scroll).toBeGreaterThan(client);
		expect(client / row).toBeGreaterThan(18);
		expect(client / row).toBeLessThan(22);
	});
});
