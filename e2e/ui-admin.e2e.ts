import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures/ui.ts';
import { getNoFollow, uniqueName } from './support/http.ts';
import { origin } from './support/env.ts';

test.describe('admin', () => {
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

	test('shows instance stats and moves data out and in through a bundle', async ({ page }) => {
		await page.goto('/admin');
		await expect(page.getByTestId('instance-stats')).toContainText('App version');
		await expect(page.getByTestId('migrations')).toContainText('applied of');
		await page.getByText('Rows per table').click();
		await expect(page.getByTestId('table-counts')).toContainText('labour_vectors');

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download export' }).click();
		const bundle = await (await download).path();
		const bytes = readFileSync(bundle);
		expect(bytes.subarray(0, 2).toString()).toBe('PK');
		expect(bytes.includes(Buffer.from('manifest.json'))).toBe(true);

		const replace = page.getByRole('button', { name: 'Replace all data' });
		const confirm = page.getByLabel('Type REPLACE ALL DATA to confirm');
		await page.locator('input[type=file]').setInputFiles(bundle);
		await expect(replace).toBeDisabled();
		await confirm.fill('replace all data');
		await expect(replace).toBeDisabled();
		await confirm.fill('REPLACE ALL DATA');
		await replace.click();
		await expect(page.getByTestId('import-done')).toContainText('Data replaced');
	});

	test('refuses a non-bundle, a missing confirmation, a foreign origin and non-Admins', async ({
		page,
		other
	}) => {
		const confirmed = {
			origin,
			'content-type': 'application/zip',
			'x-sagas-confirm': 'REPLACE ALL DATA'
		};
		const junk = Buffer.from('not a zip at all, but long enough to be read as one');
		const post = (who: typeof page, headers: Record<string, string>) =>
			who.request.post(`/admin/import?id=${'a'.repeat(16)}&offset=0&final=1`, {
				headers,
				data: junk
			});

		expect((await post(page, confirmed)).status()).toBe(422);
		expect((await post(page, { ...confirmed, 'x-sagas-confirm': 'no' })).status()).toBe(400);
		expect((await post(page, { ...confirmed, origin: 'https://evil.example' })).status()).toBe(403);
		expect((await post(other.page, confirmed)).status()).toBe(403);
		const exported = await other.page.request.post('/admin/export', { headers: { origin } });
		expect(exported.status()).toBe(403);
	});

	test('cannot be reached through encoded spellings of its paths', async ({
		playwright,
		other
	}) => {
		const stranger = await playwright.request.newContext({ baseURL: origin });
		const paths = [
			'/%61dmin/export',
			'/admin/%65xport',
			'/%61dmin/import',
			'/%61dmin/stats',
			'/admin%2Fstats'
		];
		for (const path of paths) {
			for (const [who, client] of [
				['signed out', stranger],
				['non-Admin', other.page.request]
			] as const) {
				const response = await client.post(path, {
					headers: { origin },
					maxRedirects: 0
				});
				expect(response.headers()['content-type'] ?? '', `${who} ${path}`).not.toContain(
					'application/zip'
				);
				expect(response.status(), `${who} ${path}`).not.toBe(200);
			}
			const read = await other.page.request.get(path, { maxRedirects: 0 });
			expect(read.status(), `non-Admin GET ${path}`).not.toBe(200);
		}
		await stranger.dispose();
	});

	test('is for Admins only, in its page and in every one of its actions', async ({
		other,
		admin,
		db
	}) => {
		const response = await other.page.goto('/admin');
		expect(response?.status()).toBe(403);
		await expect(other.page.getByRole('link', { name: 'Admin' })).toHaveCount(0);

		const username = uniqueName('evilbot');
		const invites = async () =>
			(await db.$client.query<{ n: number }>('SELECT count(*) AS n FROM invites')).rows[0].n;
		const before = await invites();
		const attempts: [string, Record<string, string>][] = [
			['invite', {}],
			['agent', { username, displayName: 'Evil Bot' }],
			['token', { userId: String(admin.id), name: 'stolen' }]
		];
		for (const [name, fields] of attempts) {
			const answer = await other.page.evaluate(
				async ({ name, fields }) => {
					const body = new FormData();
					for (const [key, value] of Object.entries(fields)) body.set(key, value);
					const response = await fetch(`/admin?/${name}`, {
						method: 'POST',
						body,
						headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
					});
					return (await response.json()) as { type: string; status: number };
				},
				{ name, fields }
			);
			expect(answer, name).toMatchObject({ type: 'failure', status: 403 });
		}
		expect(await invites()).toBe(before);
		expect(
			(await db.$client.query('SELECT id FROM users WHERE username = $1', [username])).rowCount
		).toBe(0);
		expect(
			(
				await db.$client.query("SELECT id FROM api_tokens WHERE user_id = $1 AND name = 'stolen'", [
					admin.id
				])
			).rowCount
		).toBe(0);
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
