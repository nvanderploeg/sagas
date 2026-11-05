import { expect, test } from './fixtures/ui.ts';

test.describe('recurrences', () => {
	test('creates a Recurrence, which makes its first Labour and links back to it', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const title = `Review chatbot errors ${Date.now().toString(36)}`;

		await page.goto(`/r/${p.key}/recurrences`);
		await page.getByLabel('Title').first().fill(title);
		await page.getByLabel('Starts on').first().fill('2026-01-01');
		await page.getByRole('button', { name: 'Create Recurrence' }).click();

		const card = page.getByTestId('recurrence').filter({ hasText: title });
		await expect(card).toContainText('Every month');
		await card.getByRole('link').click();
		await expect(page.getByTestId('labour-recurrence')).toBeVisible();
	});

	test('pausing a Recurrence shows it as paused', async ({ page, ui }) => {
		const p = ui.realm();
		const title = `Pausable ${Date.now().toString(36)}`;

		await page.goto(`/r/${p.key}/recurrences`);
		await page.getByLabel('Title').first().fill(title);
		await page.getByLabel('Starts on').first().fill('2027-01-01');
		await page.getByRole('button', { name: 'Create Recurrence' }).click();

		const card = page.getByTestId('recurrence').filter({ hasText: title });
		await expect(card).toContainText('Next on');
		await card.getByText('Edit').click();
		await card.getByLabel('Paused').check();
		await card.getByRole('button', { name: 'Save' }).click();
		await expect(card).toContainText('Paused');
	});
});
