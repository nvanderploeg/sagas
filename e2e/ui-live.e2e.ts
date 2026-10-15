import { card, cardKeys, column, expect, live, test } from './fixtures/ui.ts';

test.describe('live sync between two browsers', () => {
	test("another User's move animates in, glowing with their avatar", async ({
		page,
		other,
		ui
	}) => {
		const p = ui.project();
		const a = ui.ticket(p.id, { title: 'Watched' });
		const b = ui.ticket(p.id, { title: 'Neighbour' });

		await page.goto(`/p/${p.key}`);
		await other.page.goto(`/p/${p.key}`);
		await live(page);
		await live(other.page);

		await other.page.locator(`a[href="/t/${a.key}"]`).focus();
		await other.page.keyboard.press('Space');
		await other.page.keyboard.press('ArrowRight');
		await other.page.keyboard.press('Space');

		const doing = column(page, 'In progress');
		await expect.poll(() => cardKeys(doing)).toEqual([a.key]);
		const tag = card(page, a.key).getByTestId('remote-editor');
		await expect(tag).toBeVisible();
		await expect(tag.getByTestId('avatar')).toHaveAttribute('title', 'Pat Partner');
		await expect.poll(() => cardKeys(column(page, 'To do'))).toEqual([b.key]);
		await expect(tag).toHaveCount(0, { timeout: 5000 });
	});

	test('an edit on a Ticket page reaches the other board and Ticket page', async ({
		page,
		other,
		ui
	}) => {
		const p = ui.project();
		const t = ui.ticket(p.id, { title: 'Before' });

		const ticketTab = await page.context().newPage();
		await page.goto(`/p/${p.key}`);
		await ticketTab.goto(`/t/${t.key}`);
		await other.page.goto(`/t/${t.key}`);
		await live(page);
		await live(ticketTab);
		await live(other.page);

		await other.page.getByRole('button', { name: 'Edit title' }).click();
		await other.page.getByLabel('Title').fill('After');
		await other.page.getByRole('button', { name: 'Save title' }).click();
		await other.page.getByLabel('State', { exact: true }).selectOption({ label: 'Closed' });

		await expect(card(page, t.key)).toContainText('After');
		await expect.poll(() => cardKeys(column(page, 'Closed'))).toEqual([t.key]);
		await expect(ticketTab.getByRole('heading', { level: 1 })).toHaveText('After');
		await expect(
			ticketTab.getByLabel('State', { exact: true }).locator('option:checked')
		).toHaveText('Closed');
		await expect(ticketTab.getByTestId('remote-editor')).toContainText('Pat Partner');
		await ticketTab.close();
	});

	test("one's own create lands once, in both browsers", async ({ page, other, ui }) => {
		const p = ui.project();
		await page.goto(`/p/${p.key}`);
		await other.page.goto(`/p/${p.key}`);
		await live(page);
		await live(other.page);

		await page.getByRole('button', { name: 'Add a Ticket to To do' }).click();
		for (const title of ['One', 'Two', 'Three']) {
			await page.getByLabel('New Ticket title in To do').fill(title);
			await page.keyboard.press('Enter');
		}
		const keys = [1, 2, 3].map((n) => `${p.key}-${n}`);
		await expect.poll(() => cardKeys(column(page, 'To do'))).toEqual(keys);
		await expect.poll(() => cardKeys(column(other.page, 'To do'))).toEqual(keys);
		await page.waitForTimeout(500);
		expect(await cardKeys(column(page, 'To do'))).toEqual(keys);
		await expect(column(page, 'To do').locator('[data-card]:not([inert])')).toHaveCount(3);
	});

	test('a Project key rename re-keys open boards and Ticket pages', async ({ page, other, ui }) => {
		const p = ui.project();
		const t = ui.ticket(p.id, { title: 'Rekeyed' });
		await page.goto(`/t/${t.key}`);
		await live(page);

		const next = `${p.key.slice(0, 4)}Q`;
		await other.page.goto(`/p/${p.key}/settings`);
		await other.page.getByLabel('Key').fill(next);
		await other.page.getByRole('button', { name: 'Rename key' }).click();

		await expect(page.getByTestId('ticket-key')).toHaveText(`${next}-1`);
		await expect(page).toHaveURL(new RegExp(`/t/${next}-1$`));
	});
});
