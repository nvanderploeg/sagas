import { expect, test } from './fixtures/index.ts';
import { postForm, setCookies, uniqueName } from './support/http.ts';

const PASSWORD = 'a long enough password';

test.describe('invite', () => {
	test('accepts an invite, signs the new User in, and spends the invite', async ({
		page,
		seed
	}) => {
		const { token } = seed.invite();
		const username = uniqueName('joiner');

		await page.goto(`/invite/${token}`);
		await expect(page.getByRole('heading', { name: 'Join workload' })).toBeVisible();
		await page.getByLabel('Username').fill(username);
		await page.getByLabel('Display name').fill('New Joiner');
		await page.getByLabel('Password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Join' }).click();

		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByText(`Signed in as New Joiner (@${username})`)).toBeVisible();

		await page.goto(`/invite/${token}`);
		await expect(page.getByText('This invite is invalid or has already been used.')).toBeVisible();
	});

	test('the new User can sign in again with the chosen password', async ({
		page,
		browser,
		seed
	}) => {
		const username = uniqueName('again');
		const { token } = seed.invite();
		const joined = await postForm(page.request, `/invite/${token}`, {
			username,
			displayName: 'Again',
			password: PASSWORD
		});
		expect(joined.status()).toBe(303);

		const fresh = await browser.newPage();
		await fresh.goto('/login');
		await fresh.getByLabel('Username').fill(username);
		await fresh.getByLabel('Password').fill(PASSWORD);
		await fresh.getByRole('button', { name: 'Sign in' }).click();
		await expect(fresh.getByText('Signed in as Again')).toBeVisible();
		await fresh.close();
	});

	test('a used invite refuses a second POST', async ({ request, seed }) => {
		const { token } = seed.invite();
		const first = await postForm(request, `/invite/${token}`, {
			username: uniqueName('first'),
			displayName: 'First',
			password: PASSWORD
		});
		expect(first.status()).toBe(303);

		const second = await postForm(request, `/invite/${token}`, {
			username: uniqueName('second'),
			displayName: 'Second',
			password: PASSWORD
		});
		expect(second.status()).toBe(404);
		expect(setCookies(second)).toEqual([]);
	});

	test('an unknown token is shown as invalid and cannot be used', async ({ page, request }) => {
		await page.goto('/invite/wli_doesnotexist');
		await expect(page.getByText('This invite is invalid or has already been used.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);

		const response = await postForm(request, '/invite/wli_doesnotexist', {
			username: uniqueName('ghost'),
			displayName: 'Ghost',
			password: PASSWORD
		});
		expect(response.status()).toBe(404);
	});

	test('a taken username is refused and leaves the invite open', async ({ page, admin, seed }) => {
		const { token } = seed.invite();
		await page.goto(`/invite/${token}`);
		await page.getByLabel('Username').fill(admin.username);
		await page.getByLabel('Display name').fill('Impostor');
		await page.getByLabel('Password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Join' }).click();

		await expect(page.getByRole('alert')).toContainText('is taken');
		await expect(page.getByLabel('Display name')).toHaveValue('Impostor');

		await page.getByLabel('Username').fill(uniqueName('retry'));
		await page.getByLabel('Password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Join' }).click();
		await expect(page).toHaveURL(/\/$/);
	});

	test('a malformed username is refused', async ({ request, seed }) => {
		const { token } = seed.invite();
		const response = await postForm(request, `/invite/${token}`, {
			username: '1 bad name',
			displayName: 'Bad',
			password: PASSWORD
		});
		expect(response.status()).toBe(400);
		expect(await response.text()).toContain('Username must be 2 to 32 characters');
	});

	test.describe('password length', () => {
		for (const [length, status] of [
			[6, 400],
			[7, 303],
			[256, 303],
			[257, 400]
		] as const) {
			test(`${length} characters is ${status === 303 ? 'accepted' : 'refused'}`, async ({
				request,
				seed
			}) => {
				const { token } = seed.invite();
				const response = await postForm(request, `/invite/${token}`, {
					username: uniqueName('len'),
					displayName: 'Length',
					password: 'p'.repeat(length)
				});
				expect(response.status()).toBe(status);
				if (status === 400) {
					expect(await response.text()).toContain('Password must be 7 to 256 characters');
					const retry = await postForm(request, `/invite/${token}`, {
						username: uniqueName('len'),
						displayName: 'Length',
						password: PASSWORD
					});
					expect(retry.status()).toBe(303);
				}
			});
		}
	});
});
