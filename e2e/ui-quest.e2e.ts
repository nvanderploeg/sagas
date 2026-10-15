import { drag, expect, live, recordText, test } from './fixtures/ui.ts';

const members = (page: import('@playwright/test').Page) =>
	page
		.getByTestId('members')
		.getByTestId('ticket-row')
		.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.ticketKey));

test.describe('quests', () => {
	test('creates a Quest, adds a Ticket with its Children, and shows progress', async ({
		page,
		ui
	}) => {
		const p = ui.project();
		const epic = ui.ticket(p.id, { title: 'Epic' });
		const done = ui.ticket(p.id, { title: 'Done part', parentId: epic.id, stateId: p.closed });
		const open = ui.ticket(p.id, { title: 'Open part', parentId: epic.id });
		const name = `Launch ${Date.now().toString(36)}`;

		await page.goto('/quests');
		await page.getByLabel('New Quest').fill(name);
		await page.getByRole('button', { name: 'Create Quest' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
		await live(page);

		await page.getByLabel('Find a Ticket').fill(epic.key);
		await page.getByRole('option', { name: new RegExp(`${epic.key}.*2 Children`) }).click();
		await page.getByLabel('Also add its 2 Children').check();
		await page.getByRole('button', { name: 'Add to Quest' }).click();

		await expect.poll(() => members(page)).toEqual([epic.key, done.key, open.key]);
		const bar = page.getByRole('progressbar', { name: 'Quest progress' });
		await expect(bar).toHaveAttribute('aria-valuenow', '1');
		await expect(bar).toHaveAttribute('aria-valuemax', '3');
		await expect(page.getByTestId('xp-bar')).toContainText('1 / 3 closed');

		await page.reload();
		await expect.poll(() => members(page)).toEqual([epic.key, done.key, open.key]);
	});

	test('adding without Children adds the Ticket alone', async ({ page, ui }) => {
		const p = ui.project();
		const epic = ui.ticket(p.id, { title: 'Lonely epic' });
		ui.ticket(p.id, { title: 'Left out', parentId: epic.id });
		const quest = ui.quest('Alone');
		await page.goto(`/quests/${quest.id}`);
		await page.getByLabel('Find a Ticket').fill(epic.key);
		await page.getByRole('option', { name: new RegExp(epic.key) }).click();
		await expect(page.getByLabel('Also add its 1 Child')).not.toBeChecked();
		await page.getByRole('button', { name: 'Add to Quest' }).click();
		await expect.poll(() => members(page)).toEqual([epic.key]);
	});

	test('reorders members by drag, removes one, and celebrates completion live', async ({
		page,
		ui,
		other
	}) => {
		const p = ui.project();
		const [a, b, c] = ['One', 'Two', 'Three'].map((title) => ui.ticket(p.id, { title }));
		const quest = ui.quest('Reorder');
		for (const t of [a, b, c]) ui.addToQuest(quest.id, t.id);

		await page.goto(`/quests/${quest.id}`);
		await live(page);
		const first = (await page.getByTestId('members').locator('li').first().boundingBox())!;
		await drag(page, page.getByRole('button', { name: `Reorder ${c.key}` }), {
			x: first.x + 20,
			y: first.y + 4
		});
		await expect.poll(() => members(page)).toEqual([c.key, a.key, b.key]);
		await expect
			.poll(() => ui.readQuest(quest.id).tickets.map((t) => t.key))
			.toEqual([c.key, a.key, b.key]);

		await page.getByRole('button', { name: `Remove ${b.key} from the Quest` }).click();
		await expect.poll(() => members(page)).toEqual([c.key, a.key]);

		// Another User closes both members; this page fills the bar and celebrates without a reload.
		await other.page.goto(`/t/${a.key}`);
		await live(other.page);
		await other.page.getByLabel('State', { exact: true }).selectOption({ label: 'Closed' });
		await expect(page.getByTestId('xp-bar')).toContainText('1 / 2 closed');
		await other.page.goto(`/t/${c.key}`);
		await live(other.page);
		await other.page.getByLabel('State', { exact: true }).selectOption({ label: 'Closed' });
		await expect(page.getByTestId('quest-complete')).toBeVisible();
		await expect(page.getByTestId('quest-complete-badge')).toBeVisible();
	});

	test('edits and deletes a Quest', async ({ page, ui }) => {
		const quest = ui.quest('Rename me');
		await page.goto(`/quests/${quest.id}`);
		await page.getByRole('button', { name: 'Rename' }).click();
		await page.getByLabel('Quest name').fill('Renamed');
		await page.getByRole('button', { name: 'Save name' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed');
		await expect.poll(() => ui.readQuest(quest.id).name).toBe('Renamed');

		await page.getByRole('button', { name: 'Delete Quest' }).click();
		await page.getByRole('button', { name: 'Delete Renamed' }).click();
		await expect(page).toHaveURL(/\/quests$/);
	});

	test('celebrates only a member becoming Closed, not a removal or a Closed addition', async ({
		page,
		ui
	}) => {
		const p = ui.project();
		const done = ui.ticket(p.id, { title: 'Done', stateId: p.closed });
		const open = ui.ticket(p.id, { title: 'Open' });
		const quest = ui.quest('Almost');
		ui.addToQuest(quest.id, done.id);
		ui.addToQuest(quest.id, open.id);
		await page.goto(`/quests/${quest.id}`);
		await live(page);

		const moments = await recordText(page, '[data-testid="quest-complete"]');
		await page.getByRole('button', { name: `Remove ${open.key} from the Quest` }).click();
		await expect(page.getByTestId('quest-complete-badge')).toBeVisible();
		await page.waitForTimeout(400);
		expect(await moments()).toEqual(['(none)']);

		const empty = ui.quest('Empty');
		await page.goto(`/quests/${empty.id}`);
		await live(page);
		const quiet = await recordText(page, '[data-testid="quest-complete"]');
		await page.getByLabel('Find a Ticket').fill(done.key);
		await page.getByRole('option', { name: new RegExp(done.key) }).click();
		await page.getByRole('button', { name: 'Add to Quest' }).click();
		await expect(page.getByTestId('quest-complete-badge')).toBeVisible();
		await page.waitForTimeout(400);
		expect(await quiet()).toEqual(['(none)']);
	});
});
