import { expect, test } from './fixtures/index.ts';
import { postForm, setCookies } from './support/http.ts';

test.describe('session cookie over plain http', () => {
	test('is httpOnly, SameSite=Lax and not Secure', async ({ page, admin }) => {
		const response = await postForm(page.request, '/login', {
			username: admin.username,
			password: admin.password
		});
		expect(response.status()).toBe(303);

		const [header] = setCookies(response).filter((c) => c.startsWith('workload_session='));
		const attributes = header.split(';').map((a) => a.trim().toLowerCase());
		expect(attributes).toContain('httponly');
		expect(attributes).toContain('samesite=lax');
		expect(attributes).toContain('path=/');
		expect(attributes).not.toContain('secure');
		expect(attributes.some((a) => a.startsWith('expires='))).toBe(true);

		const [cookie] = (await page.context().cookies()).filter((c) => c.name === 'workload_session');
		expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false, path: '/' });
		expect(cookie.expires).toBeGreaterThan(Date.now() / 1000);
	});

	test('is not readable from page scripts', async ({ signedInPage: page }) => {
		await page.goto('/');
		expect(await page.evaluate(() => document.cookie)).not.toContain('workload_session');
	});

	test('is cleared on logout', async ({ signedInPage: page }) => {
		const response = await postForm(page.request, '/logout', {});
		expect(response.status()).toBe(303);

		const [header] = setCookies(response).filter((c) => c.startsWith('workload_session='));
		expect(header).not.toMatch(/;\s*secure/i);
		expect((await page.context().cookies()).map((c) => c.name)).not.toContain('workload_session');
	});

	test('has the same flags when an invite is accepted', async ({ request, seed }) => {
		const { token } = seed.invite();
		const response = await postForm(request, `/invite/${token}`, {
			username: `cookie${Date.now().toString(36)}`,
			displayName: 'Cookie',
			password: 'a long enough password'
		});
		expect(response.status()).toBe(303);

		const [header] = setCookies(response).filter((c) => c.startsWith('workload_session='));
		expect(header).toMatch(/httponly/i);
		expect(header).toMatch(/samesite=lax/i);
		expect(header).not.toMatch(/;\s*secure/i);
	});
});
