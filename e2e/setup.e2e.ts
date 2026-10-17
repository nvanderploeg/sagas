import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { adminFile, origin } from './support/env.ts';
import { getNoFollow, postForm } from './support/http.ts';
import { openStream } from './support/stream.ts';

test.describe.configure({ mode: 'serial' });

const admin = {
	username: 'admin',
	displayName: 'Ada Admin',
	password: 'correct horse battery'
};

test('an empty database sends every page to /setup', async ({ page, request }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/setup$/);
	await expect(page.getByRole('heading', { name: 'Set up sagas' })).toBeVisible();

	for (const path of ['/', '/login', '/realms', '/invite/wli_nothing']) {
		const response = await getNoFollow(request, path);
		expect(response.status(), path).toBe(303);
		expect(response.headers().location, path).toBe('/setup');
	}
});

test('machine endpoints answer 401 JSON, not a redirect, on an empty database', async ({
	request
}) => {
	const challenges = {
		'/mcp': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
		'/api/events': 'Bearer',
		'/api/anything': 'Bearer'
	};
	for (const [path, challenge] of Object.entries(challenges)) {
		const response = await getNoFollow(request, path);
		expect(response.status(), path).toBe(401);
		expect(response.headers()['www-authenticate'], path).toBe(challenge);
		expect(await response.json(), path).toEqual({ error: 'unauthorized' });
	}
});

test('setup rejects a password outside 7 to 256 characters and creates nobody', async ({
	request
}) => {
	for (const length of [6, 257]) {
		const response = await postForm(request, '/setup', {
			username: admin.username,
			displayName: admin.displayName,
			password: 'x'.repeat(length)
		});
		expect(response.status(), `${length} characters`).toBe(400);
		expect(await response.text()).toContain('Password must be 7 to 256 characters');
	}

	const response = await getNoFollow(request, '/setup');
	expect(response.status()).toBe(200);
});

test('setup creates the first Admin and shows one API token, once', async ({ page, context }) => {
	await page.goto('/setup');
	await page.getByLabel('Username').fill(admin.username);
	await page.getByLabel('Display name').fill(admin.displayName);
	await page.getByLabel('Password').fill(admin.password);
	await page.getByRole('button', { name: 'Create Admin' }).click();

	const token = page.locator('code');
	await expect(token).toHaveText(/^wlt_[A-Za-z0-9_-]{20,}$/);
	const setupToken = (await token.textContent())!;
	expect(await page.locator('code').count()).toBe(1);

	await page.goto('/setup');
	await expect(page).toHaveURL(/\/$/);
	expect(await page.content()).not.toContain(setupToken);

	expect((await context.cookies()).map((c) => c.name)).toContain('sagas_session');

	writeFileSync(adminFile, JSON.stringify({ ...admin, setupToken }));
});

test('the setup token authenticates as a Bearer', async ({ request }) => {
	const { setupToken } = JSON.parse(readFileSync(adminFile, 'utf8'));

	const stream = await openStream({ authorization: `Bearer ${setupToken}` });
	expect(stream.response.status).toBe(200);
	await stream.close();

	const anonymous = await getNoFollow(request, '/api/events');
	expect(anonymous.status()).toBe(401);
});

test('setup is locked: GET redirects to /login and POST creates nobody', async ({ request }) => {
	const get = await getNoFollow(request, '/setup');
	expect(get.status()).toBe(303);
	expect(get.headers().location).toBe('/login');

	const post = await postForm(request, '/setup', {
		username: 'intruder',
		displayName: 'Intruder',
		password: 'another good password'
	});
	expect(post.status()).toBe(409);
	expect(post.headers()['set-cookie']).toBeUndefined();

	const login = await postForm(request, '/login', {
		username: 'intruder',
		password: 'another good password'
	});
	expect(login.status()).toBe(400);
});

test('a signed-in Admin is sent from /setup to /', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill(admin.username);
	await page.getByLabel('Password').fill(admin.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto('/setup');
	await expect(page).toHaveURL(/\/$/);
});
