import { exchangeSession, expect, test } from './fixtures/index.ts';
import { postForm, setCookies } from './support/http.ts';

test.describe('session cookie over plain http', () => {
	test('is httpOnly, SameSite=Lax and not Secure', async ({ page, admin }) => {
		const response = await exchangeSession(page.request, admin.email);
		expect(response.status()).toBe(200);

		const [header] = setCookies(response).filter((c) => c.startsWith('runestone_session='));
		const attributes = header.split(';').map((a) => a.trim().toLowerCase());
		expect(attributes).toContain('httponly');
		expect(attributes).toContain('samesite=lax');
		expect(attributes).toContain('path=/');
		expect(attributes).not.toContain('secure');
		expect(attributes.some((a) => a.startsWith('expires='))).toBe(true);

		const [cookie] = (await page.context().cookies()).filter((c) => c.name === 'runestone_session');
		expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false, path: '/' });
		expect(cookie.expires).toBeGreaterThan(Date.now() / 1000);
	});

	test('is not readable from page scripts', async ({ signedInPage: page }) => {
		await page.goto('/');
		expect(await page.evaluate(() => document.cookie)).not.toContain('runestone_session');
	});

	test('is cleared on logout', async ({ signedInPage: page }) => {
		const response = await postForm(page.request, '/logout', {});
		expect(response.status()).toBe(303);

		const [header] = setCookies(response).filter((c) => c.startsWith('runestone_session='));
		expect(header).not.toMatch(/;\s*secure/i);
		expect((await page.context().cookies()).map((c) => c.name)).not.toContain('runestone_session');
	});
});
