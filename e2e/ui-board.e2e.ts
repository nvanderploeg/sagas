import { card, cardKeys, column, drag, expect, live, test } from './fixtures/ui.ts';

test.describe('board', () => {
	test('shows one column per State in order, Closed last, with Substates as badges', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const a = ui.labour(p.id, { title: 'Write the brief' });
		const b = ui.labour(p.id, { title: 'Ship it', stateId: p.doing });
		ui.substate(p.doing, 'Review');

		await page.goto(`/r/${p.key}`);
		await expect(page.getByRole('heading', { name: p.name, level: 1 })).toBeVisible();
		await expect(page.getByTestId('column')).toHaveCount(3);
		expect(
			await page.getByTestId('column').evaluateAll((els) => els.map((e) => e.dataset.state))
		).toEqual(['To do', 'In progress', 'Closed']);
		await expect(card(page, a.key)).toContainText('Write the brief');
		await expect(column(page, 'In progress').locator('[data-card]')).toHaveCount(1);
		await expect(card(page, b.key).getByTestId('state-pill')).toHaveText(/Review/);
	});

	test('a former Realm key redirects to the board under the current key', async ({ page, ui }) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}/settings`);
		const next = `${p.key.slice(0, 5)}X`;
		await page.getByLabel('Key').fill(next);
		await page.getByRole('button', { name: 'Rename key' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${next}/settings$`));

		await page.goto(`/r/${p.key.toLowerCase()}`);
		await expect(page).toHaveURL(new RegExp(`/r/${next}$`));
	});

	test('dragging a card to another column changes its State, and it stays after a reload', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const a = ui.labour(p.id, { title: 'Move me' });
		ui.labour(p.id, { title: 'Stay', stateId: p.doing });

		await page.goto(`/r/${p.key}`);
		await live(page);
		const target = (await column(page, 'In progress')
			.locator('[data-card]')
			.first()
			.boundingBox())!;
		await drag(page, card(page, a.key), { x: target.x + target.width / 2, y: target.y + 4 });

		await expect(column(page, 'In progress').locator('[data-card]')).toHaveCount(2);
		expect(await cardKeys(column(page, 'In progress'))).toEqual([a.key, expect.any(String)]);
		await expect.poll(() => ui.readLabour(a.id).stateId).toBe(p.doing);

		await page.reload();
		expect(await cardKeys(column(page, 'In progress'))).toContain(a.key);
		await expect(column(page, 'To do').locator('[data-card]')).toHaveCount(0);
	});

	test('dragging within a column sets the Rank, and the order holds after a reload', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const [a, b, c] = ['First', 'Second', 'Third'].map((title) => ui.labour(p.id, { title }));

		await page.goto(`/r/${p.key}`);
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
		const p = ui.realm();
		const a = ui.labour(p.id, { title: 'Keyboard' });
		const b = ui.labour(p.id, { title: 'Other' });

		await page.goto(`/r/${p.key}`);
		await live(page);
		await page.locator(`a[href="/l/${b.key}"]`).focus();
		await page.keyboard.press('Space');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Space');
		await expect.poll(() => cardKeys(column(page, 'To do'))).toEqual([b.key, a.key]);

		await page.locator(`a[href="/l/${a.key}"]`).focus();
		await page.keyboard.press('Space');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');
		await expect.poll(() => cardKeys(column(page, 'Closed'))).toEqual([a.key]);
		await expect(page.getByTestId('loot-burst')).toHaveCount(1);
		await expect.poll(() => ui.readLabour(a.id).closed).toBe(true);
	});

	test('quick-creates a Labour into a column', async ({ page, ui }) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}`);
		await live(page);
		await page.getByRole('button', { name: 'Add a Labour to In progress' }).click();
		await page.getByLabel('New Labour title in In progress').fill('Born in progress');
		await page.keyboard.press('Enter');

		const lane = column(page, 'In progress');
		await expect(lane.locator('[data-card]')).toHaveCount(1);
		await expect(lane.locator('[data-card]')).toContainText(`${p.key}-1`);
		await page.reload();
		await expect(lane).toContainText('Born in progress');
	});

	test('filters by owner and by assignee', async ({ page, ui }) => {
		const p = ui.realm();
		const tag = Date.now().toString(36);
		const name = `Filter Bot ${tag}`;
		const bot = ui.agent(`bot${tag}`, name);
		ui.labour(p.id, { title: 'Mine, unassigned' });
		ui.labour(p.id, { title: 'For the bot', assigneeId: bot.id });

		await page.goto(`/r/${p.key}`);
		const todo = column(page, 'To do');
		await expect(todo.locator('[data-card]')).toHaveCount(2);
		await page.getByLabel('Assignee').selectOption({ label: name });
		await expect(todo.locator('[data-card]')).toHaveCount(1);
		await expect(todo).toContainText('For the bot');
		await page.getByLabel('Assignee').selectOption({ label: 'Unassigned' });
		await expect(todo).toContainText('Mine, unassigned');
		await page.getByLabel('Owner').selectOption({ label: name });
		await expect(todo.locator('[data-card]')).toHaveCount(0);
		await page.getByRole('button', { name: 'Clear filters' }).click();
		await expect(todo.locator('[data-card]')).toHaveCount(2);
	});

	test('a long column stays within the viewport and scrolls on its own', async ({ page, ui }) => {
		const p = ui.realm();
		for (let i = 0; i < 40; i++) ui.labour(p.id, { title: `Pile ${i}` });
		ui.labour(p.id, { title: 'Alone', stateId: p.doing });
		await page.goto(`/r/${p.key}`);
		await live(page);

		const todo = column(page, 'To do');
		const lane = (await todo.boundingBox())!;
		expect(lane.y + lane.height).toBeLessThanOrEqual(page.viewportSize()!.height);
		const list = todo.locator('[data-list]');
		await list.evaluate((el) => (el.scrollTop = 400));
		expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		await expect(column(page, 'In progress').locator('[data-card]')).toBeInViewport();
	});

	test('dragging empty board space pans it sideways and scrolls the column under it', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		for (let i = 0; i < 40; i++) ui.labour(p.id, { title: `Pile ${i}` });
		await page.setViewportSize({ width: 600, height: 700 });
		await page.goto(`/r/${p.key}`);
		await live(page);

		const todo = column(page, 'To do');
		const head = (await todo.locator('header').boundingBox())!;
		const x = head.x + head.width / 2;
		const y = head.y + head.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x - 150, y - 200, { steps: 8 });
		await expect(page.locator('html')).toHaveClass(/panning/);
		await page.mouse.up();

		await expect(page.locator('html')).not.toHaveClass(/panning/);
		expect(await page.locator('.scroller').evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
		expect(await todo.locator('[data-list]').evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
		await expect(page.getByTestId('floating-card')).toHaveCount(0);
	});

	test('dragging from inline text on the board pans it', async ({ page, ui }) => {
		const p = ui.realm();
		await page.setViewportSize({ width: 600, height: 700 });
		await page.goto(`/r/${p.key}`);
		await live(page);

		const head = column(page, 'To do').locator('header');
		await head.evaluate((el) => {
			const text = document.createElement('span');
			text.dataset.testid = 'inline-text';
			text.textContent = 'inline';
			const block = document.createElement('div');
			block.append(text);
			el.append(block);
		});
		const box = (await page.getByTestId('inline-text').boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x - 150, box.y, { steps: 8 });
		await expect(page.locator('html')).toHaveClass(/panning/);
		await page.mouse.up();
		expect(await page.locator('.scroller').evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
	});

	test('leaving the board mid-drag drops the drag and never moves the card', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const a = ui.labour(p.id, { title: 'Held' });
		ui.labour(p.id, { title: 'Target', stateId: p.doing });
		await page.goto(`/r/${p.key}`);
		await live(page);
		const moves: string[] = [];
		page.on('request', (request) => {
			if (request.method() === 'POST') moves.push(request.url());
		});

		const box = (await card(page, a.key).boundingBox())!;
		const target = (await column(page, 'In progress').boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 30, { steps: 4 });
		await expect(page.getByTestId('floating-card')).toBeVisible();
		await expect(page.locator('html')).toHaveClass(/dragging/);

		await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a.brand')!.click());
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Hello');
		await expect(page.locator('html')).not.toHaveClass(/dragging/);
		await page.mouse.move(target.x + target.width / 2, target.y + 40, { steps: 6 });
		await page.mouse.up();
		await page.keyboard.press('Space');
		await page.waitForTimeout(400);

		expect(moves).toEqual([]);
		expect(ui.readLabour(a.id).stateId).toBe(p.todo);
	});

	test.describe('with reduced motion', () => {
		test('moves land at once and nothing animates or transitions', async ({ page, ui }) => {
			const p = ui.realm();
			const a = ui.labour(p.id, { title: 'Calm' });
			ui.labour(p.id, { title: 'Neighbour' });
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.addInitScript(() => {
				const seen: string[] = [];
				(window as unknown as { motion: string[] }).motion = seen;
				const animate = Element.prototype.animate;
				Element.prototype.animate = function (keyframes, options) {
					const duration = typeof options === 'number' ? options : Number(options?.duration ?? 0);
					if (duration > 0) seen.push(`animate ${duration}ms`);
					return animate.call(this, keyframes, options);
				};
				document.addEventListener('animationstart', (e) =>
					seen.push(`animation ${e.animationName}`)
				);
				document.addEventListener('transitionrun', (e) =>
					seen.push(`transition ${e.propertyName}`)
				);
			});
			await page.goto(`/r/${p.key}`);
			await live(page);

			await page.locator(`a[href="/l/${a.key}"]`).focus();
			await page.keyboard.press('Space');
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('Space');
			await expect.poll(() => cardKeys(column(page, 'Closed'))).toEqual([a.key]);
			await page.waitForTimeout(300);

			const running = await page.evaluate(() =>
				document
					.getAnimations()
					.filter((animation) => {
						const { duration } = animation.effect?.getComputedTiming() ?? {};
						return animation.playState === 'running' && Number(duration) > 0;
					})
					.map((animation) => animation.constructor.name)
			);
			expect(running).toEqual([]);
			expect(await page.evaluate(() => (window as unknown as { motion: string[] }).motion)).toEqual(
				[]
			);
			await expect(page.getByTestId('loot-burst')).toHaveCSS('display', 'none');
		});
	});
});
