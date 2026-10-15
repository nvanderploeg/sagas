import { expect, test } from './fixtures/index.ts';
import { getNoFollow, postForm } from './support/http.ts';

test.describe('login', () => {
	test('signs in with the right password', async ({ page, admin }) => {
		await page.goto('/login');
		await page.getByLabel('Username').fill(admin.username);
		await page.getByLabel('Password').fill(admin.password);
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByText(`Signed in as ${admin.displayName}`)).toBeVisible();
	});

	test('accepts the username in any case', async ({ page, admin }) => {
		await page.goto('/login');
		await page.getByLabel('Username').fill(admin.username.toUpperCase());
		await page.getByLabel('Password').fill(admin.password);
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page.getByText(`Signed in as ${admin.displayName}`)).toBeVisible();
	});

	test('refuses a wrong password and keeps the username', async ({ page, admin, context }) => {
		await page.goto('/login');
		await page.getByLabel('Username').fill(admin.username);
		await page.getByLabel('Password').fill('not the password');
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page.getByRole('alert')).toHaveText('Wrong username or password');
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByLabel('Username')).toHaveValue(admin.username);
		expect(await context.cookies()).toEqual([]);
	});

	test('gives an unknown user the same answer as a wrong password', async ({ request, admin }) => {
		const wrong = await postForm(request, '/login', {
			username: admin.username,
			password: 'not the password'
		});
		const unknown = await postForm(request, '/login', {
			username: 'nobody-here',
			password: 'not the password'
		});

		expect(unknown.status()).toBe(wrong.status());
		expect(await unknown.text()).toContain('Wrong username or password');
	});

	test('sends a signed-in user from /login to /', async ({ signedInPage }) => {
		await signedInPage.goto('/login');
		await expect(signedInPage).toHaveURL(/\/$/);
	});

	test('sends a signed-out page request to /login', async ({ request }) => {
		const response = await getNoFollow(request, '/');
		expect(response.status()).toBe(303);
		expect(response.headers().location).toBe('/login');
	});
});

test.describe('logout', () => {
	test('ends the session and returns to /login', async ({ signedInPage: page }) => {
		await page.goto('/');
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login$/);

		await page.goto('/');
		await expect(page).toHaveURL(/\/login$/);
	});

	test('invalidates the session token on the server', async ({ signedInPage: page, request }) => {
		const [session] = (await page.context().cookies()).filter((c) => c.name === 'sagas_session');
		const before = await request.get('/', {
			headers: { cookie: `sagas_session=${session.value}` },
			maxRedirects: 0
		});
		expect(before.status()).toBe(200);

		await page.goto('/');
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login$/);

		const after = await request.get('/', {
			headers: { cookie: `sagas_session=${session.value}` },
			maxRedirects: 0
		});
		expect(after.status()).toBe(303);
		expect(after.headers().location).toBe('/login');
	});
});
