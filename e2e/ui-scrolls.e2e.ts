import { drag, expect, live, test } from './fixtures/ui.ts';

const treeTitles = (page: import('@playwright/test').Page) =>
	page.getByTestId('scroll-tree').getByRole('link').allTextContents();

test.describe('scrolls', () => {
	test('creates a Scroll from the board, writes it and links to a page that does not exist yet', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		await page.goto(`/r/${p.key}`);
		await page.getByRole('link', { name: 'Scrolls' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s$`));

		await page.getByLabel('Title').fill('Release process');
		await page.getByRole('button', { name: 'Create Scroll' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s/release-process$`));
		await expect(page.getByLabel('Body (Markdown)')).toBeFocused();

		await page
			.getByLabel('Body (Markdown)')
			.fill('Steps live in [[Release process/Checklist|the checklist]].');
		await page.getByRole('button', { name: 'Save' }).click();
		const missing = page.getByTestId('scroll-body').getByRole('link', { name: 'the checklist' });
		await expect(missing).toHaveAttribute('data-missing', '');

		await missing.click();
		await expect(page.getByTestId('missing-scroll')).toContainText('release-process/checklist');
		await expect(page.getByLabel('Title')).toHaveValue('Checklist');
		await page.getByRole('button', { name: 'Create this Scroll' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s/release-process/checklist$`));
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByTestId('backlinks')).toContainText('Release process');

		await page
			.getByRole('navigation', { name: 'Breadcrumb' })
			.getByRole('link', { name: 'Release process' })
			.click();
		await expect(
			page.getByTestId('scroll-body').getByRole('link', { name: 'the checklist' })
		).not.toHaveAttribute('data-missing');
	});

	test('renaming a slug keeps the old address working', async ({ page, ui }) => {
		const p = ui.realm();
		const ops = ui.scroll(p.id, 'Ops');
		ui.scroll(p.id, 'Deploys', { parentId: ops.id });

		await page.goto(`/r/${p.key}/s/ops`);
		await live(page);
		await page.getByRole('button', { name: 'Edit' }).click();
		await page.getByLabel('Slug').fill('operations');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s/operations$`));

		await page.goto(`/r/${p.key}/s/ops/deploys`);
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s/operations/deploys$`));
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deploys');
	});

	test('a save from a stale version is refused and keeps the draft', async ({ page, ui }) => {
		const p = ui.realm();
		const scroll = ui.scroll(p.id, 'Notes', { body: 'first' });

		await page.goto(`/r/${p.key}/s/notes`);
		await live(page);
		await page.getByRole('button', { name: 'Edit' }).click();
		await page.getByLabel('Body (Markdown)').fill('mine');
		await ui.updateScroll(scroll.id, 'theirs');
		await page.getByRole('button', { name: 'Save' }).click();

		await expect(page.getByRole('alert')).toContainText('changed after version 1');
		await expect(page.getByLabel('Body (Markdown)')).toHaveValue('mine');
		expect(ui.readScroll(scroll.id).body).toBe('theirs');
	});

	test('dragging a page under its parent reorders it', async ({ page, ui }) => {
		const p = ui.realm();
		const parent = ui.scroll(p.id, 'Guides');
		const a = ui.scroll(p.id, 'Alpha', { parentId: parent.id });
		ui.scroll(p.id, 'Beta', { parentId: parent.id });

		await page.goto(`/r/${p.key}/s/guides`);
		await live(page);
		const list = page.getByRole('list', { name: 'Pages under Guides' });
		const last = (await list.getByRole('listitem').last().boundingBox())!;
		await drag(page, page.getByRole('button', { name: 'Reorder Alpha' }), {
			x: last.x + last.width / 2,
			y: last.y + last.height - 2
		});

		await expect.poll(() => list.getByRole('link').allTextContents()).toEqual(['Beta', 'Alpha']);
		await page.reload();
		await expect(
			page.getByRole('list', { name: 'Pages under Guides' }).getByRole('link')
		).toHaveText(['Beta', 'Alpha']);
		expect(ui.readScroll(a.id).parentId).toBe(parent.id);
	});

	test('deleting a page asks about each child: one moves up, one goes', async ({ page, ui }) => {
		const p = ui.realm();
		const parent = ui.scroll(p.id, 'Old area');
		ui.scroll(p.id, 'Keep me', { parentId: parent.id });
		const drop = ui.scroll(p.id, 'Drop me', { parentId: parent.id });
		ui.scroll(p.id, 'Drop leaf', { parentId: drop.id });

		await page.goto(`/r/${p.key}/s/old-area`);
		await page.getByRole('button', { name: 'Delete' }).click();
		const panel = page.getByTestId('delete-panel');
		await panel.getByRole('button', { name: 'Delete all' }).click();
		await panel.getByRole('radiogroup', { name: 'Keep me' }).getByLabel('Move up').check();
		await panel.getByRole('button', { name: 'Delete 3 Scrolls' }).click();
		await panel.getByRole('button', { name: 'Delete for good' }).click();

		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s$`));
		await expect.poll(() => treeTitles(page)).toEqual(['Keep me']);
	});

	test('search finds a Scroll by its body, and a Labour lists the Scrolls naming it', async ({
		page,
		ui
	}) => {
		const p = ui.realm();
		const labour = ui.labour(p.id, { title: 'Fix the deploy' });
		ui.scroll(p.id, 'Runbook', { body: `Rollback steps for ${labour.key}.` });

		await page.goto(`/r/${p.key}/s`);
		await page.getByRole('searchbox', { name: 'Search Scrolls' }).fill('rollback');
		await page.getByRole('searchbox', { name: 'Search Scrolls' }).press('Enter');
		await expect(page.getByTestId('scroll-hits')).toContainText('Runbook');

		await page.goto(`/l/${labour.key}`);
		await page.getByTestId('labour-scrolls').getByRole('link', { name: 'Runbook' }).click();
		await expect(page).toHaveURL(new RegExp(`/r/${p.key}/s/runbook$`));
	});

	test("another User's new Scroll appears in the tree without a reload", async ({
		page,
		other,
		ui
	}) => {
		const p = ui.realm();
		ui.scroll(p.id, 'First');
		await page.goto(`/r/${p.key}/s/first`);
		await live(page);

		await other.page.goto(`/r/${p.key}/s`);
		await other.page.getByLabel('Title').fill('Second');
		await other.page.getByRole('button', { name: 'Create Scroll' }).click();
		await expect(other.page).toHaveURL(new RegExp(`/r/${p.key}/s/second$`));

		await expect.poll(() => treeTitles(page)).toEqual(['First', 'Second']);
	});
});
