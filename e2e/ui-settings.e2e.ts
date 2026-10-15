import { expect, test } from './fixtures/ui.ts';
import { postForm } from './support/http.ts';

const states = (page: import('@playwright/test').Page) =>
	page
		.getByTestId('state-settings')
		.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.state));

test.describe('realm settings', () => {
	test('never renames, removes or reorders Closed, and keeps it out of the Initial State', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}/settings`);
		expect(await states(page)).toEqual(['To do', 'In progress', 'Closed']);

		const closed = page.locator('[data-testid="state-settings"][data-state="Closed"]');
		await expect(closed.getByText('Built in · always last')).toBeVisible();
		await expect(closed.getByRole('textbox').first()).toHaveAttribute('readonly', '');
		await expect(closed.getByRole('button', { name: 'Delete' })).toHaveCount(0);
		await expect(closed.getByRole('button', { name: /^Move Closed/ })).toHaveCount(0);
		await expect(
			page.getByLabel('New Labours land in').locator('option', { hasText: 'Closed' })
		).toHaveCount(0);

		const renamed = await postForm(page.request, `/r/${p.key}/settings?/updateState`, {
			stateId: String(p.closed),
			label: 'Done'
		});
		expect(renamed.status()).toBe(403);
		await page.reload();
		expect(await states(page)).toEqual(['To do', 'In progress', 'Closed']);
	});

	test('adds a State before Closed, reorders it, and deletes it', async ({ page, ui }) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}/settings`);
		await page.getByLabel('New State label').fill('Review');
		await page.getByRole('button', { name: 'Add State' }).click();
		await expect.poll(() => states(page)).toEqual(['To do', 'In progress', 'Review', 'Closed']);

		await page.getByRole('button', { name: 'Move Review earlier' }).click();
		await expect.poll(() => states(page)).toEqual(['To do', 'Review', 'In progress', 'Closed']);

		await page.goto(`/r/${p.key}`);
		expect(
			await page.getByTestId('column').evaluateAll((els) => els.map((e) => e.dataset.state))
		).toEqual(['To do', 'Review', 'In progress', 'Closed']);

		await page.goto(`/r/${p.key}/settings`);
		const review = page.locator('[data-testid="state-settings"][data-state="Review"]');
		await review.getByRole('button', { name: 'Delete' }).click();
		await review.getByRole('button', { name: 'Delete Review' }).click();
		await expect.poll(() => states(page)).toEqual(['To do', 'In progress', 'Closed']);
	});

	test('refuses to delete a State that holds Labours, inline', async ({ page, ui }) => {
		const p = ui.realm();
		ui.labour(p.id, { stateId: p.doing });
		await page.goto(`/r/${p.key}/settings`);
		const doing = page.locator('[data-testid="state-settings"][data-state="In progress"]');
		await doing.getByRole('button', { name: 'Delete' }).click();
		await doing.getByRole('button', { name: 'Delete In progress' }).click();
		await expect(doing.getByRole('alert')).toHaveText('The State still holds Labours');
	});

	test('gives Closed Substates, with a default, and renames the Realm', async ({ page, ui }) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}/settings`);
		const closed = page.locator('[data-testid="state-settings"][data-state="Closed"]');
		await closed.getByLabel('New Substate of Closed label').fill('Done');
		await closed.getByRole('button', { name: 'Add Substate' }).click();
		const subs = closed.getByTestId('substate-settings');
		await expect(subs).toHaveCount(1);
		await expect(closed.getByLabel('New Substate of Closed label')).toHaveValue('');
		await closed.getByLabel('New Substate of Closed label').fill("Won't do");
		await closed.getByRole('button', { name: 'Add Substate' }).click();
		await expect(subs).toHaveCount(2);
		await expect(subs.nth(0)).toContainText('Default');
		await subs.nth(1).getByRole('button', { name: 'Make default' }).click();
		await expect(subs.nth(1)).toContainText('Default');

		await page.getByLabel('Name', { exact: true }).fill('Renamed board');
		await page.getByRole('button', { name: 'Save name' }).click();
		await page.goto(`/r/${p.key}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed board');
	});
});
