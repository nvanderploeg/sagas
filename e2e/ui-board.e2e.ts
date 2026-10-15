import { card, cardKeys, column, drag, expect, live, test } from './fixtures/ui.ts';

test.describe('board', () => {
	test('shows one column per State in order, Closed last, with Substates as badges', async ({
		page,
		ui
	}) => {
		const p = ui.project();
		const a = ui.ticket(p.id, { title: 'Write the brief' });
		const b = ui.ticket(p.id, { title: 'Ship it', stateId: p.doing });
		ui.substate(p.doing, 'Review');

		await page.goto(`/p/${p.key}`);
		await expect(page.getByRole('heading', { name: p.name, level: 1 })).toBeVisible();
		await expect(page.getByTestId('column')).toHaveCount(3);
		expect(
			await page.getByTestId('column').evaluateAll((els) => els.map((e) => e.dataset.state))
		).toEqual(['To do', 'In progress', 'Closed']);
		await expect(card(page, a.key)).toContainText('Write the brief');
		await expect(column(page, 'In progress').locator('[data-card]')).toHaveCount(1);
		await expect(card(page, b.key).getByTestId('state-pill')).toHaveText(/Review/);
	});

	test('a former Project key redirects to the board under the current key', async ({
		page,
		ui
	}) => {
		const p = ui.project();
		await page.goto(`/p/${p.key}/settings`);
		const next = `${p.key.slice(0, 5)}X`;
		await page.getByLabel('Key').fill(next);
		await page.getByRole('button', { name: 'Rename key' }).click();
		await expect(page).toHaveURL(new RegExp(`/p/${next}/settings$`));

		await page.goto(`/p/${p.key.toLowerCase()}`);
		await expect(page).toHaveURL(new RegExp(`/p/${next}$`));
	});

	test('dragging a card to another column changes its State, and it stays after a reload', async ({
		page,
		ui
	}) => {
		const p = ui.project();
		const a = ui.ticket(p.id, { title: 'Move me' });
		ui.ticket(p.id, { title: 'Stay', stateId: p.doing });

		await page.goto(`/p/${p.key}`);
		await live(page);
		const target = (await column(page, 'In progress')
			.locator('[data-card]')
			.first()
			.boundingBox())!;
		await drag(page, card(page, a.key), { x: target.x + target.width / 2, y: target.y + 4 });

		await expect(column(page, 'In progress').locator('[data-card]')).toHaveCount(2);
		expect(await cardKeys(column(page, 'In progress'))).toEqual([a.key, expect.any(String)]);
		await expect.poll(() => ui.readTicket(a.id).stateId).toBe(p.doing);

		await page.reload();
		expect(await cardKeys(column(page, 'In progress'))).toContain(a.key);
		await expect(column(page, 'To do').locator('[data-card]')).toHaveCount(0);
	});

	test('dragging within a column sets the Rank, and the order holds after a reload', async ({
		page,
		ui
	}) => {
		const p = ui.project();
		const [a, b, c] = ['First', 'Second', 'Third'].map((title) => ui.ticket(p.id, { title }));

		await page.goto(`/p/${p.key}`);
		await live(page);
		const todo = column(page, 'To do');
		expect(await cardKeys(todo)).toEqual([a.key, b.key, c.key]);

		const top = (await card(page, a.key).boundingBox())!;
		await drag(page, card(page, c.key), { x: top.x + top.width / 2, y: top.y + 6 });
		await expect.poll(() => cardKeys(todo)).toEqual([c.key, a.key, b.key]);

		await page.reload();
		await expect.poll(() => cardKeys(todo)).toEqual([c.key, a.key, b.key]);
	});

	test('moves a card with the keyboard alone', async ({ page, ui }) => {
		const p = ui.project();
		const a = ui.ticket(p.id, { title: 'Keyboard' });
		const b = ui.ticket(p.id, { title: 'Other' });

		await page.goto(`/p/${p.key}`);
		await live(page);
		await page.locator(`a[href="/t/${b.key}"]`).focus();
		await page.keyboard.press('Space');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Space');
		await expect.poll(() => cardKeys(column(page, 'To do'))).toEqual([b.key, a.key]);

		await page.locator(`a[href="/t/${a.key}"]`).focus();
		await page.keyboard.press('Space');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');
		await expect.poll(() => cardKeys(column(page, 'Closed'))).toEqual([a.key]);
		await expect(page.getByTestId('loot-burst')).toHaveCount(1);
		await expect.poll(() => ui.readTicket(a.id).closed).toBe(true);
	});

	test('quick-creates a Ticket into a column', async ({ page, ui }) => {
		const p = ui.project();
		await page.goto(`/p/${p.key}`);
		await live(page);
		await page.getByRole('button', { name: 'Add a Ticket to In progress' }).click();
		await page.getByLabel('New Ticket title in In progress').fill('Born in progress');
		await page.keyboard.press('Enter');

		const lane = column(page, 'In progress');
		await expect(lane.locator('[data-card]')).toHaveCount(1);
		await expect(lane.locator('[data-card]')).toContainText(`${p.key}-1`);
		await page.reload();
		await expect(lane).toContainText('Born in progress');
	});

	test('filters by owner and by assignee', async ({ page, ui }) => {
		const p = ui.project();
		const bot = ui.agent(`bot${Date.now().toString(36)}`, 'Filter Bot');
		ui.ticket(p.id, { title: 'Mine, unassigned' });
		ui.ticket(p.id, { title: 'For the bot', assigneeId: bot.id });

		await page.goto(`/p/${p.key}`);
		const todo = column(page, 'To do');
		await expect(todo.locator('[data-card]')).toHaveCount(2);
		await page.getByLabel('Assignee').selectOption({ label: 'Filter Bot' });
		await expect(todo.locator('[data-card]')).toHaveCount(1);
		await expect(todo).toContainText('For the bot');
		await page.getByLabel('Assignee').selectOption({ label: 'Unassigned' });
		await expect(todo).toContainText('Mine, unassigned');
		await page.getByLabel('Owner').selectOption({ label: 'Filter Bot' });
		await expect(todo.locator('[data-card]')).toHaveCount(0);
		await page.getByRole('button', { name: 'Clear filters' }).click();
		await expect(todo.locator('[data-card]')).toHaveCount(2);
	});

	test.describe('with reduced motion', () => {
		test('moves land at once and closing plays no burst', async ({ page, ui }) => {
			const p = ui.project();
			const a = ui.ticket(p.id, { title: 'Calm' });
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.goto(`/p/${p.key}`);
			await live(page);
			await page.locator(`a[href="/t/${a.key}"]`).focus();
			await page.keyboard.press('Space');
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('Space');

			await expect(column(page, 'To do').locator('[data-card]')).toHaveCount(0);
			await expect.poll(() => cardKeys(column(page, 'Closed'))).toEqual([a.key]);
			await expect(page.getByTestId('loot-burst')).toHaveCSS('display', 'none');
		});
	});
});
