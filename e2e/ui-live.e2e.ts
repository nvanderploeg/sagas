import { card, cardKeys, column, expect, live, test } from './fixtures/ui.ts';

test.describe('live sync between two browsers', () => {
	test("another User's move animates in, glowing with their avatar", async ({
		page,
		other,
		ui
	}) => {
		const p = ui.realm();
		const a = ui.labour(p.id, { title: 'Watched' });
		const b = ui.labour(p.id, { title: 'Neighbour' });

		await page.goto(`/r/${p.key}`);
		await other.page.goto(`/r/${p.key}`);
		await live(page);
		await live(other.page);

		await other.page.locator(`a[href="/l/${a.key}"]`).focus();
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

	test('an edit on a Labour page reaches the other board and Labour page', async ({
		page,
		other,
		ui
	}) => {
		const p = ui.realm();
		const t = ui.labour(p.id, { title: 'Before' });

		const labourTab = await page.context().newPage();
		await page.goto(`/r/${p.key}`);
		await labourTab.goto(`/l/${t.key}`);
		await other.page.goto(`/l/${t.key}`);
		await live(page);
		await live(labourTab);
		await live(other.page);

		await other.page.getByRole('button', { name: 'Edit title' }).click();
		await other.page.getByLabel('Title').fill('After');
		await other.page.getByRole('button', { name: 'Save title' }).click();
		await other.page.getByLabel('State', { exact: true }).selectOption({ label: 'Closed' });

		await expect(card(page, t.key)).toContainText('After');
		await expect.poll(() => cardKeys(column(page, 'Closed'))).toEqual([t.key]);
		await expect(labourTab.getByRole('heading', { level: 1 })).toHaveText('After');
		await expect(
			labourTab.getByLabel('State', { exact: true }).locator('option:checked')
		).toHaveText('Closed');
		await expect(labourTab.getByTestId('remote-editor')).toContainText('Pat Partner');
		await labourTab.close();
	});

	test("one's own create lands once, in both browsers", async ({ page, other, ui }) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}`);
		await other.page.goto(`/r/${p.key}`);
		await live(page);
		await live(other.page);

		await page.getByRole('button', { name: 'Add a Labour to To do' }).click();
		for (const title of ['One', 'Two', 'Three']) {
			await page.getByLabel('New Labour title in To do').fill(title);
			await page.keyboard.press('Enter');
		}
		const keys = [1, 2, 3].map((n) => `${p.key}-${n}`);
		await expect.poll(() => cardKeys(column(page, 'To do'))).toEqual(keys);
		await expect.poll(() => cardKeys(column(other.page, 'To do'))).toEqual(keys);
		await page.waitForTimeout(500);
		expect(await cardKeys(column(page, 'To do'))).toEqual(keys);
		await expect(column(page, 'To do').locator('[data-card]:not([inert])')).toHaveCount(3);
	});

	test('a Realm key rename re-keys open boards and Labour pages', async ({ page, other, ui }) => {
		const p = ui.realm();
		const t = ui.labour(p.id, { title: 'Rekeyed' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		const next = `${p.key.slice(0, 4)}Q`;
		await other.page.goto(`/r/${p.key}/settings`);
		await other.page.getByLabel('Key').fill(next);
		await other.page.getByRole('button', { name: 'Rename key' }).click();

		await expect(page.getByTestId('labour-key')).toHaveText(`${next}-1`);
		await expect(page).toHaveURL(new RegExp(`/l/${next}-1$`));
	});

	test('a User who joined after the page loaded shows by name, never blank', async ({
		page,
		other,
		ui
	}) => {
		const p = ui.realm();
		const t = ui.labour(p.id, { title: 'Handed over' });
		await other.page.goto(`/r/${p.key}`);
		const labourTab = await other.context.newPage();
		await labourTab.goto(`/l/${t.key}`);
		await live(other.page);
		await live(labourTab);

		const tag = Date.now().toString(36);
		const name = `Late Bot ${tag}`;
		ui.agent(`late${tag}`, name);
		await page.goto(`/l/${t.key}`);
		await live(page);
		await page.getByLabel('Owner').selectOption({ label: name });
		await page.getByLabel('Assignee').selectOption({ label: name });

		await expect(labourTab.getByLabel('Owner').locator('option:checked')).toHaveText(name);
		await expect(labourTab.getByLabel('Assignee').locator('option:checked')).toHaveText(name);
		await expect(
			labourTab.getByRole('complementary', { name: 'Labour fields' }).getByTestId('avatar')
		).toHaveAttribute('title', name);
		await expect(card(other.page, t.key).getByTitle(`Assignee: ${name}`)).toBeVisible();
		await labourTab.close();
	});
});
