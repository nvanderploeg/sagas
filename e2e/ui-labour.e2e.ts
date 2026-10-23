import { expect, holdAction, holdLoads, live, recordText, test } from './fixtures/ui.ts';

test.describe('labour page', () => {
	test('edits the title and the Markdown description, rendered without raw HTML', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const t = ui.labour(p.id, { title: 'Draft title' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		await page.getByRole('button', { name: 'Edit title' }).click();
		await page.getByLabel('Title').fill('Final title');
		await page.getByRole('button', { name: 'Save title' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Final title');

		await page.getByRole('button', { name: 'Edit description' }).click();
		await page
			.getByLabel('Description (Markdown)')
			.fill(
				'Some **bold** text\n\n<img src=x onerror="window.pwned=1">\n\n[bad](javascript:alert(1))'
			);
		await page.getByRole('tab', { name: 'Preview' }).click();
		await expect(page.getByTestId('markdown').locator('strong')).toHaveText('bold');
		await page.getByRole('button', { name: 'Save description' }).click();

		const body = page.getByTestId('markdown');
		await expect(body.locator('strong')).toHaveText('bold');
		await expect(body.locator('img')).toHaveCount(0);
		await expect(body).toContainText('<img src=x');
		await expect(body.locator('a[href^="javascript"]')).toHaveCount(0);

		await page.reload();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Final title');
		await expect(page.getByTestId('markdown').locator('strong')).toHaveText('bold');
		expect(
			await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)
		).toBeUndefined();
		expect(ui.readLabour(t.id).description).toContain('**bold**');
	});

	test('sets State, Substate, Owner and Assignee', async ({ page, ui }) => {
		const p = ui.realm();
		ui.substate(p.doing, 'Coding');
		ui.substate(p.doing, 'Review');
		const tag = Date.now().toString(36);
		const name = `Field Bot ${tag}`;
		const bot = ui.agent(`bot${tag}`, name);
		ui.join(p.id, bot.id);
		const t = ui.labour(p.id, { title: 'Fields' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		await page.getByLabel('State', { exact: true }).selectOption({ label: 'In progress' });
		await expect(page.getByLabel('Substate')).toHaveValue(/\d+/);
		await page.getByLabel('Substate').selectOption({ label: 'Review' });
		await page.getByLabel('Assignee').selectOption({ label: name });
		await page.getByLabel('Owner').selectOption({ label: name });

		await expect
			.poll(() => {
				const now = ui.readLabour(t.id);
				return [now.stateId, now.assigneeId, now.ownerId];
			})
			.toEqual([p.doing, bot.id, bot.id]);
		await page.reload();
		await expect(page.getByLabel('Substate').locator('option:checked')).toHaveText('Review');
	});

	test('sets the Parent by key search, lists Children, and clears the Parent', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const parent = ui.labour(p.id, { title: 'The epic' });
		const child = ui.labour(p.id, { title: 'A part' });
		await page.goto(`/l/${child.key}`);
		await live(page);

		await page.getByLabel('Set Parent').fill(parent.key);
		await page.getByRole('option', { name: new RegExp(parent.key) }).click();
		await expect(page.getByTestId('parent')).toContainText('The epic');
		await expect.poll(() => ui.readLabour(child.id).parentId).toBe(parent.id);

		await page.goto(`/l/${parent.key}`);
		await expect(page.getByTestId('children')).toContainText('A part');

		await page.goto(`/l/${child.key}`);
		await page.getByTestId('parent').getByRole('button', { name: 'Clear' }).click();
		await expect(page.getByTestId('parent')).toHaveCount(0);
		await expect.poll(() => ui.readLabour(child.id).parentId).toBeNull();
	});

	test('moves to another Realm, and the old key redirects to the new one', async ({ page, ui }) => {
		const from = ui.realm();
		const to = ui.realm();
		const t = ui.labour(from.id, { title: 'Travelling' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		await page.getByText('Move to another Realm').click();
		await page.getByLabel('Target Realm').selectOption({ value: String(to.id) });
		await page.getByLabel('Target State').selectOption({ label: 'In progress' });
		await page.getByRole('button', { name: `Move to ${to.key}` }).click();

		const moved = `${to.key}-1`;
		await expect(page).toHaveURL(new RegExp(`/l/${moved}$`));
		await expect(page.getByTestId('labour-key')).toHaveText(moved);
		expect(ui.readLabour(t.id)).toMatchObject({ realmId: to.id, stateId: to.doing });

		await page.goto(`/l/${t.key}`);
		await expect(page).toHaveURL(new RegExp(`/l/${moved}$`));
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Travelling');
	});

	test('a Closed Labour can only move into the target Closed', async ({ page, ui }) => {
		const from = ui.realm();
		const to = ui.realm();
		const t = ui.labour(from.id, { stateId: from.closed });
		await page.goto(`/l/${t.key}`);
		await page.getByText('Move to another Realm').click();
		await page.getByLabel('Target Realm').selectOption({ value: String(to.id) });
		await expect(page.getByLabel('Target State')).toBeDisabled();
		await expect(page.getByLabel('Target State').locator('option:checked')).toHaveText('Closed');
		await expect(page.getByText('A Closed Labour stays Closed.')).toBeVisible();
		await page.getByRole('button', { name: `Move to ${to.key}` }).click();
		await expect(page).toHaveURL(new RegExp(`/l/${to.key}-1$`));
		expect(ui.readLabour(t.id)).toMatchObject({ stateId: to.closed, closed: true });
	});

	test('joins and leaves a Quest, and deletes the Labour', async ({ page, ui }) => {
		const p = ui.realm();
		const quest = ui.quest(p.id, `Side quest ${Date.now().toString(36)}`);
		const t = ui.labour(p.id, { title: 'Doomed' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		await page.getByLabel('Quest to add this Labour to').selectOption({ label: quest.name });
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByTestId('labour-quests')).toContainText(quest.name);
		await expect.poll(() => ui.readQuest(quest.id).labours.map((m) => m.id)).toEqual([t.id]);

		await page.getByRole('button', { name: `Remove from ${quest.name}` }).click();
		await expect(page.getByTestId('labour-quests')).toHaveCount(0);
		await expect.poll(() => ui.readQuest(quest.id).labours).toEqual([]);

		await page.getByRole('button', { name: 'Delete Labour' }).click();
		await page.getByRole('button', { name: `Delete ${t.key} for good` }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}$`));
		const gone = await page.goto(`/l/${t.key}`);
		expect(gone?.status()).toBe(404);
	});

	test('posts a Comment that stays after a reload', async ({ page, ui }) => {
		const t = ui.labour(ui.realm().id, { title: 'Discussed' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		await page.getByLabel('New Comment (Markdown)').fill('Resolved: **shipped**');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await expect(page.getByTestId('comments')).toContainText('Resolved: shipped');
		await expect(page.getByLabel('New Comment (Markdown)')).toHaveValue('');

		await page.reload();
		await expect(page.getByTestId('comments')).toContainText('Resolved: shipped');
	});

	test("edits and deletes one's own Comment", async ({ page, ui }) => {
		const t = ui.labour(ui.realm().id, { title: 'Discussed' });
		await page.goto(`/l/${t.key}`);
		await live(page);
		await page.getByLabel('New Comment (Markdown)').fill('first draft');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await expect(page.getByTestId('comments')).toContainText('first draft');

		await page.getByRole('button', { name: 'Edit Comment' }).click();
		await page.getByLabel('Edit Comment (Markdown)').fill('second draft');
		await page.getByRole('button', { name: 'Save Comment' }).click();
		await expect(page.getByTestId('comments')).toContainText('second draft');
		await expect(page.getByTestId('comments')).toContainText('(edited)');

		await page.getByRole('button', { name: 'Delete Comment' }).click();
		await page.getByRole('button', { name: 'Delete this Comment for good' }).click();
		await expect(page.getByTestId('comments')).toHaveCount(0);
		await page.reload();
		await expect(page.getByText('No Comments yet.')).toBeVisible();
	});

	test('following a Child link starts the next Labour clean, with nothing carried over', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const elsewhere = ui.realm();
		const parent = ui.labour(p.id, { title: 'Parent', description: 'Parent text' });
		const child = ui.labour(p.id, {
			title: 'Open child',
			parentId: parent.id,
			description: 'Child text'
		});
		await page.goto(`/l/${parent.key}`);
		await live(page);

		await page.getByRole('button', { name: 'Edit description' }).click();
		await page.getByLabel('Description (Markdown)').fill('PARENT DRAFT');
		await page.getByRole('button', { name: 'Edit title' }).click();
		await page.getByLabel('Title').fill('Parent title draft');
		await page.getByText('Move to another Realm').click();
		await page.getByLabel('Target Realm').selectOption({ value: String(elsewhere.id) });

		await page
			.getByTestId('children')
			.getByRole('link', { name: /Open child/ })
			.click();
		await expect(page).toHaveURL(new RegExp(`/l/${child.key}$`));
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Open child');
		await expect(page.getByTestId('markdown')).toHaveText('Child text');
		await expect(page.getByLabel('Description (Markdown)')).toHaveCount(0);
		await expect(page.getByLabel('Title')).toHaveCount(0);
		await expect(page.getByLabel('Target State')).toHaveCount(0);
		await expect(page.getByRole('button', { name: `Move to ${elsewhere.key}` })).toHaveCount(0);
		expect(ui.readLabour(child.id)).toMatchObject({
			title: 'Open child',
			description: 'Child text'
		});
	});

	test('plays the loot burst only when the Labour it shows becomes Closed', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const parent = ui.labour(p.id, { title: 'Parent' });
		ui.labour(p.id, { title: 'Closed child', parentId: parent.id, stateId: p.closed });
		await page.goto(`/l/${parent.key}`);
		await live(page);

		await page
			.getByTestId('children')
			.getByRole('link', { name: /Closed child/ })
			.click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Closed child');
		await page.waitForTimeout(300);
		await expect(page.getByTestId('loot-burst')).toHaveCount(0);

		await page.getByTestId('parent').getByRole('link').click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Parent');
		await page.waitForTimeout(300);
		await expect(page.getByTestId('loot-burst')).toHaveCount(0);
		await page.getByLabel('State', { exact: true }).selectOption({ label: 'Closed' });
		await expect(page.getByTestId('loot-burst')).toHaveCount(1);
	});

	test("setting one's own Parent never flips back, even when its Event beats the answer", async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const a = ui.labour(p.id, { title: 'Parent A' });
		const b = ui.labour(p.id, { title: 'Parent B' });
		const t = ui.labour(p.id, { title: 'Kid' });
		await page.goto(`/l/${t.key}`);
		await live(page);
		await holdAction(page, 'parent', 200);
		await holdLoads(page, 800);

		const shown = await recordText(page, '[data-testid="parent"] [data-testid="labour-row"]');
		await page.getByLabel('Set Parent').fill(a.key);
		await page.getByRole('option', { name: new RegExp(a.key) }).click();
		await expect.poll(() => ui.readLabour(t.id).parentId).toBe(a.id);
		await page.waitForTimeout(1000);
		expect((await shown()).map((text) => text.split(' ')[0])).toEqual(['(none)', a.key]);

		const changed = await recordText(page, '[data-testid="parent"] [data-testid="labour-row"]');
		await page.getByLabel('Change Parent').fill(b.key);
		await page.getByRole('option', { name: new RegExp(b.key) }).click();
		await expect.poll(() => ui.readLabour(t.id).parentId).toBe(b.id);
		await page.waitForTimeout(1000);
		expect((await changed()).map((text) => text.split(' ')[0])).toEqual([a.key, b.key]);
	});

	test('deleting the Labour oneself goes straight to the board', async ({ page, ui }) => {
		const p = ui.realm();
		const t = ui.labour(p.id, { title: 'Doomed' });
		await page.goto(`/l/${t.key}`);
		await live(page);
		await holdAction(page, 'delete');

		const headings = await recordText(page, 'main h1');
		await page.getByRole('button', { name: 'Delete Labour' }).click();
		await page.getByRole('button', { name: `Delete ${t.key} for good` }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}$`));
		expect(await headings()).not.toContain('This Labour was deleted');
	});

	test('the Move panel never offers the Realm the Labour was moved to meanwhile', async ({
		page,
		other,
		ui
	}) => {
		const from = ui.realm();
		const to = ui.realm();
		const t = ui.labour(from.id, { title: 'Wanderer' });
		await page.goto(`/l/${t.key}`);
		await live(page);
		await page.getByText('Move to another Realm').click();
		await page.getByLabel('Target Realm').selectOption({ value: String(to.id) });
		await expect(page.getByRole('button', { name: `Move to ${to.key}` })).toBeVisible();

		await other.page.goto(`/l/${t.key}`);
		await other.page.getByText('Move to another Realm').click();
		await other.page.getByLabel('Target Realm').selectOption({ value: String(to.id) });
		await other.page.getByRole('button', { name: `Move to ${to.key}` }).click();

		await expect(page.getByTestId('labour-key')).toHaveText(`${to.key}-1`);
		await expect(page.getByRole('button', { name: `Move to ${to.key}` })).toHaveCount(0);
		await expect(
			page.getByLabel('Target Realm').locator('option', { hasText: `(${to.key})` })
		).toHaveCount(0);
		await expect(
			page.getByLabel('Target Realm').locator('option', { hasText: `(${from.key})` })
		).toHaveCount(1);
	});

	test('keeps focus on the control that replaces the one pressed', async ({ page, ui }) => {
		const p = ui.realm();
		const t = ui.labour(p.id, { title: 'Focus' });
		await page.goto(`/l/${t.key}`);
		await live(page);

		const editTitle = page.getByRole('button', { name: 'Edit title' });
		await editTitle.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Title')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(editTitle).toBeFocused();
		await page.keyboard.press('Enter');
		await page.getByLabel('Title').fill('Focus kept');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Focus kept');
		await expect(editTitle).toBeFocused();
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(editTitle).toBeFocused();

		const editBody = page.getByRole('button', { name: 'Edit description' });
		await editBody.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Description (Markdown)')).toBeFocused();
		await page.getByRole('button', { name: 'Cancel' }).focus();
		await page.keyboard.press('Enter');
		await expect(editBody).toBeFocused();
		await page.keyboard.press('Enter');
		await page.getByLabel('Description (Markdown)').fill('Saved');
		await page.getByRole('button', { name: 'Save description' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('markdown')).toHaveText('Saved');
		await expect(editBody).toBeFocused();

		const remove = page.getByRole('button', { name: 'Delete Labour' });
		await remove.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('button', { name: `Delete ${t.key} for good` })).toBeFocused();
		await page.getByRole('button', { name: 'Cancel' }).focus();
		await page.keyboard.press('Enter');
		await expect(remove).toBeFocused();
	});
});
