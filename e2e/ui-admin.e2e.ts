import { expect, test } from './fixtures/ui.ts';
import { getNoFollow, uniqueName } from './support/http.ts';

const PASSWORD = 'a long enough password';

test.describe('admin', () => {
	test('creates an Invite, shows its link once, and the invitee joins', async ({
		page,
		browser
	}) => {
		await page.goto('/admin');
		await page.getByRole('button', { name: 'Create Invite' }).click();
		const link = await page.getByTestId('secret').locator('code').textContent();
		expect(link).toMatch(/\/invite\/wli_/);

		await page.reload();
		await expect(page.getByTestId('secret')).toHaveCount(0);
		await expect(page.getByTestId('invite').first()).toContainText('Open');

		const username = uniqueName('newbie');
		const guest = await browser.newContext();
		const joining = await guest.newPage();
		await joining.goto(link!);
		await joining.getByLabel('Username').fill(username);
		await joining.getByLabel('Display name').fill('New Bie');
		await joining.getByLabel('Password').fill(PASSWORD);
		await joining.getByRole('button', { name: 'Join' }).click();
		await expect(joining.getByText(`Signed in as New Bie (@${username})`)).toBeVisible();
		await guest.close();

		await page.reload();
		await expect(page.getByTestId('users')).toContainText(`@${username}`);
		await expect(page.getByTestId('invite').first()).toContainText('Used by New Bie');
	});

	test('creates an Agent user and manages its API tokens', async ({ page, request }) => {
		const username = uniqueName('agent');
		await page.goto('/admin');
		await page.getByLabel('Username').fill(username);
		await page.getByLabel('Display name').fill('Robo Helper');
		await page.getByRole('button', { name: 'Create Agent user' }).click();

		const agent = page.getByTestId('agent').filter({ hasText: `@${username}` });
		await expect(agent).toBeVisible();
		await agent.getByLabel('Token name').fill('ci');
		await agent.getByRole('button', { name: 'Create token' }).click();
		const token = await agent.getByTestId('secret').locator('code').textContent();
		expect(token).toMatch(/^wl/);

		const works = await getNoFollow(request, '/api/events?since=not-a-seq', {
			authorization: `Bearer ${token}`
		});
		expect(works.status()).toBe(400);

		await agent.getByRole('button', { name: 'Revoke' }).click();
		await agent.getByRole('button', { name: 'Revoke ci' }).click();
		await expect(agent.getByTestId('token')).toContainText('Revoked');
		const refused = await getNoFollow(request, '/api/events?since=not-a-seq', {
			authorization: `Bearer ${token}`
		});
		expect(refused.status()).toBe(401);
	});

	test('is for Admins only', async ({ other }) => {
		const response = await other.page.goto('/admin');
		expect(response?.status()).toBe(403);
		await expect(other.page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
	});
});

test.describe('account', () => {
	test('creates and revokes its own API token, and signs out', async ({ other }) => {
		const { page } = other;
		await page.goto('/account');
		await page.getByLabel('Token name').fill('laptop');
		await page.getByRole('button', { name: 'Create token' }).click();
		await expect(page.getByTestId('secret')).toContainText('wl');
		await page.reload();
		await expect(page.getByTestId('secret')).toHaveCount(0);
		await page.getByRole('button', { name: 'Revoke' }).click();
		await page.getByRole('button', { name: 'Revoke laptop' }).click();
		await expect(page.getByTestId('token')).toContainText('Revoked');

		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login$/);
	});
});
