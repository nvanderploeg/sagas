import type { Page } from '@playwright/test';
import { expect, test, type UiSeed } from './fixtures/ui.ts';
import { getNoFollow, uniqueName } from './support/http.ts';

const on = (page: Page) => page.addInitScript(() => localStorage.setItem('sagas-advanced', 'on'));
const toggle = (page: Page) =>
	page.getByRole('banner').getByRole('switch', { name: 'Advanced view' });
const layer = (page: Page) => page.getByRole('region', { name: 'Agent layer' });

// One unbroken token, the shape that can widen a page.
const token = (prefix: string, length = 300) => (prefix + 'x'.repeat(length)).slice(0, length);

function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	return errors;
}

async function fitsAt(
	page: Page,
	path: string,
	width: number,
	ready: (page: Page) => Promise<void>
) {
	await page.setViewportSize({ width, height: 900 });
	await page.goto(path);
	await ready(page);
	const { scroll, inner } = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		inner: window.innerWidth
	}));
	expect.soft(scroll, `${path} at ${width}px`).toBeLessThanOrEqual(inner);
}

function watchAgentRequests(page: Page): string[] {
	const seen: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).pathname.startsWith('/api/agent/')) seen.push(request.url());
	});
	return seen;
}

// A Realm whose Labour carries one of everything the Advanced view shows.
function seeded(ui: UiSeed) {
	const realm = ui.realm();
	const effort = ui.attribute(realm.id, {
		key: 'effort',
		kind: 'scale',
		label: 'Effort',
		rubric: 'How much work, **1** small to 5 large.',
		spec: { min: 1, max: 5 }
	});
	const area = ui.attribute(realm.id, {
		key: 'area',
		kind: 'tags',
		label: 'Area',
		rubric: 'Where it lands.',
		spec: {
			members: [
				{ key: 'net', label: 'Networking' },
				{ key: 'ui', label: 'Interface' }
			]
		}
	});
	ui.tune(realm.id, { notes: 'Ask the **netcode** lead first.', halfLifeDays: 21, loudness: 7 });
	ui.skill({ key: 'netcode', label: 'Netcode' });

	const target = ui.labour(realm.id, { title: 'Rubber-banding on join' });
	const blocker = ui.labour(realm.id, { title: 'Server tick audit' });
	ui.values(target.id, { effort: 4, area: ['net'] });
	ui.appraise([
		{
			labourId: target.id,
			brief: 'Players snap back when joining a full lobby.',
			refs: [
				{ href: 'https://example.com/report', label: 'Crash report' },
				{ href: 'javascript:alert(1)' }
			],
			links: [{ type: 'blocks', from: blocker.id, note: 'Needs the tick fix' }],
			needs: { netcode: 4 },
			stamp: ui.contentHash(target.id)
		}
	]);
	ui.comment(blocker.id, `Related to ${target.key}`);
	ui.pulses(realm.id, [
		{ key: 'effort', amount: 4, mood: -1 },
		{ key: 'area:net', amount: 2, mood: 0.5 },
		{ key: 'wishlist', amount: 1, mood: 1 }
	]);
	return { realm, effort, area, target, blocker };
}

test.describe('advanced view', () => {
	test('off by default: no agent layer shown and none fetched', async ({ page, ui }) => {
		const { realm, target } = seeded(ui);
		const requests = watchAgentRequests(page);

		for (const path of [`/l/${target.key}`, `/r/${realm.key}/settings`, '/account']) {
			await page.goto(path);
			await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
			await expect(layer(page)).toHaveCount(0);
			await expect(page.getByText('Agent layer')).toHaveCount(0);
		}
		await page.waitForTimeout(300);
		expect(requests).toEqual([]);
	});

	test('on, a Labour page shows its Brief, values, Link, need, Mention and stamp', async ({
		page,
		ui
	}) => {
		const { target, blocker } = seeded(ui);
		await page.addInitScript(() => {
			const blocked: string[] = [];
			(window as unknown as { blocked: string[] }).blocked = blocked;
			document.addEventListener('securitypolicyviolation', (e) =>
				blocked.push(`${e.violatedDirective} ${e.blockedURI}`)
			);
		});
		await page.goto(`/l/${target.key}`);
		await expect(layer(page)).toHaveCount(0);

		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
		const panel = layer(page);
		await expect(panel.getByTestId('agent-brief')).toHaveText(
			'Players snap back when joining a full lobby.'
		);

		const values = panel.getByTestId('agent-values').getByRole('listitem');
		await expect(values).toHaveCount(2);
		await expect(values.nth(0)).toContainText('Effort');
		await expect(values.nth(0)).toContainText('4 / 5');
		await expect(values.nth(0)).toContainText('Admin');
		await expect(values.nth(0)).toContainText('UTC');
		await expect(values.nth(1)).toContainText('Networking');
		await expect(values.nth(0)).not.toContainText('stale');

		await expect(panel.getByTestId('agent-needs')).toContainText('Netcode');
		await expect(panel.getByTestId('agent-needs')).toContainText('level 4');

		const group = panel.getByTestId('agent-link-group');
		await expect(group).toHaveCount(1);
		await expect(group).toContainText('Blocked by');
		await expect(group).toContainText('Needs the tick fix');
		await expect(group.getByRole('link', { name: new RegExp(blocker.title) })).toHaveAttribute(
			'href',
			`/l/${blocker.key}`
		);

		await expect(panel.getByTestId('agent-mentions')).toContainText(blocker.title);
		await expect(panel.getByTestId('agent-stamp')).toContainText('Appraised by');
		await expect(panel.getByTestId('agent-stamp')).not.toContainText('stale');
		await expect(panel.getByTestId('agent-status')).toContainText('Updated');
		await expect(panel.locator('[aria-live]')).toHaveCount(1);
		await expect(panel.locator('[aria-live]')).toHaveAttribute('data-testid', 'agent-status');

		const web = panel.getByRole('link', { name: 'Crash report' });
		await expect(web).toHaveAttribute('href', 'https://example.com/report');
		await expect(web).toHaveAttribute('rel', 'noopener noreferrer nofollow');
		await expect(web).toHaveAttribute('target', '_blank');
		await expect(panel.locator('a[href^="javascript"]')).toHaveCount(0);
		await expect(panel.locator('code', { hasText: 'javascript:alert(1)' })).toBeVisible();

		expect(await page.evaluate(() => (window as unknown as { blocked: string[] }).blocked)).toEqual(
			[]
		);
	});

	test('shows a stamp as stale once the Labour changes, and Refresh picks it up', async ({
		page,
		ui
	}) => {
		const { target } = seeded(ui);
		await on(page);
		await page.goto(`/l/${target.key}`);
		await expect(layer(page).getByTestId('agent-stamp')).not.toContainText('stale');

		ui.comment(target.id, 'New information');
		await layer(page).getByRole('button', { name: 'Refresh' }).click();
		await expect(layer(page).getByTestId('agent-stamp')).toContainText('stale');
	});

	test('a failed load says so on the status line', async ({ page, ui }) => {
		const { target } = seeded(ui);
		await page.route('**/api/agent/labours/*', (route) => route.fulfill({ status: 500 }));
		await on(page);
		await page.goto(`/l/${target.key}`);
		await expect(layer(page).getByTestId('agent-status')).toHaveText(
			'The agent layer could not be loaded.'
		);
		await expect(layer(page).getByTestId('agent-brief')).toHaveCount(0);
	});

	test('an unappraised Labour with nothing kept says so', async ({ page, ui }) => {
		const realm = ui.realm();
		const bare = ui.labour(realm.id, { title: 'Untouched' });
		await on(page);
		await page.goto(`/l/${bare.key}`);
		await expect(layer(page)).toContainText('No agent layer yet.');
	});

	test('survives a reload, and turning it off removes the panel', async ({ page, ui }) => {
		const { target } = seeded(ui);
		await page.goto(`/l/${target.key}`);
		await toggle(page).click();
		await expect(layer(page)).toBeVisible();

		await page.reload();
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
		await expect(layer(page).getByTestId('agent-brief')).toBeVisible();

		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
		await expect(layer(page)).toHaveCount(0);
		await page.reload();
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
		await expect(layer(page)).toHaveCount(0);
	});

	test('another tab follows the switch', async ({ page }) => {
		await page.goto('/');
		const second = await page.context().newPage();
		await second.goto('/');
		await expect(toggle(second)).toHaveAttribute('aria-checked', 'false');

		await toggle(page).click();
		await expect(toggle(second)).toHaveAttribute('aria-checked', 'true');
		await toggle(page).click();
		await expect(toggle(second)).toHaveAttribute('aria-checked', 'false');
	});

	test('the switch is keyboard operable', async ({ page }) => {
		await page.goto('/');
		await toggle(page).focus();
		await page.keyboard.press('Space');
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Enter');
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
	});

	test('on, a Realm settings page shows notes, Attributes, Sentiment and unfiled keys', async ({
		page,
		ui
	}) => {
		const { realm } = seeded(ui);
		await on(page);
		await page.goto(`/r/${realm.key}/settings`);
		const panel = layer(page);

		await expect(panel.locator('strong', { hasText: 'netcode' })).toBeVisible();
		await expect(panel).toContainText('Half-life 21 days');
		await expect(panel).toContainText('Loudness 7');

		const attributes = panel.getByTestId('agent-attributes').getByRole('listitem');
		await expect(attributes.filter({ hasText: 'Effort' })).toContainText('scale');
		await expect(attributes.filter({ hasText: 'Effort' }).locator('strong')).toHaveText('1');
		await expect(attributes.filter({ hasText: 'Effort' })).toContainText(
			'Held by 1 Labour, 0 stale'
		);
		await expect(attributes.filter({ hasText: 'Area' })).toContainText('Networking');

		const sentiment = panel.getByTestId('agent-sentiment');
		await expect(sentiment).toContainText('Effort');
		await expect(sentiment).toContainText('Area: Networking');
		await expect(sentiment).toContainText('volume 4.0');
		await expect(sentiment).toContainText('mood -1.00');

		await expect(panel.getByTestId('agent-unfiled')).toContainText('wishlist');
		await expect(panel.getByRole('button', { name: 'Delete Realm' })).toHaveCount(0);
	});

	test('on, the account page shows the User’s Skills and Affinity', async ({ page, ui, admin }) => {
		const { realm, area } = seeded(ui);
		ui.skills(admin.id, { netcode: 3 });
		ui.affinity(admin.id, area.id, 'net', 'area:net');
		await on(page);
		await page.goto('/account');
		const panel = layer(page);

		await expect(panel.getByTestId('agent-skills')).toContainText('Netcode');
		await expect(panel.getByTestId('agent-skills')).toContainText('level 3');
		const affinity = panel.getByTestId('agent-affinity');
		await expect(affinity).toContainText(realm.key);
		await expect(affinity).toContainText('Area: Networking');
		await expect(affinity).toContainText('volume 2.0');
		await expect(page.getByRole('switch', { name: 'Advanced view' })).toHaveCount(2);
	});

	test('a tags Attribute whose members share a label still renders the Realm settings page', async ({
		page,
		ui
	}) => {
		const realm = ui.realm();
		ui.attribute(realm.id, {
			key: 'platform',
			kind: 'tags',
			label: 'Platform',
			rubric: 'Where it breaks.',
			spec: {
				members: [
					{ key: 'pc', label: 'Desktop' },
					{ key: 'mac', label: 'Desktop' }
				]
			}
		});
		const held = ui.labour(realm.id, { title: 'Crash on launch' });
		ui.values(held.id, { platform: ['pc'] });
		const errors = watchErrors(page);
		await on(page);
		await page.goto(`/r/${realm.key}/settings`);

		const platform = layer(page)
			.getByTestId('agent-attributes')
			.getByRole('listitem')
			.filter({ hasText: 'Platform' })
			.first();
		await expect(platform).toContainText('Held by 1 Labour');
		await expect(platform.getByTestId('agent-counts').getByRole('listitem')).toHaveText([
			'Desktop 1',
			'Desktop 0'
		]);
		await expect(page.getByRole('heading', { name: 'Delete Realm' })).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('long unbroken tokens never widen the page', async ({ page, ui, admin }) => {
		const realm = ui.realm();
		const summary = ui.attribute(realm.id, {
			key: 'summary',
			kind: 'text',
			label: 'Summary',
			rubric: '```\n' + token('rubric') + '\n```',
			spec: { max: 1000 }
		});
		ui.tune(realm.id, { notes: token('notes') + '\n\n```\n' + token('code') + '\n```' });
		ui.skill({ key: 'netcode', label: token('skill', 64) });
		ui.skills(admin.id, { netcode: 2 });
		ui.affinity(admin.id, summary.id, null, 'summary');
		const target = ui.labour(realm.id, { title: 'Wide' });
		const other = ui.labour(realm.id, { title: 'Other' });
		ui.values(target.id, { summary: token('value') });
		ui.appraise([
			{
				labourId: target.id,
				brief: token('brief'),
				refs: [{ href: token('ref:') }, { href: token('https://example.com/') }],
				links: [{ type: 'relates', to: other.id, note: token('note') }],
				needs: { netcode: 3 }
			}
		]);
		ui.pulses(realm.id, [{ key: `${'a'.repeat(32)}:${'b'.repeat(32)}`, amount: 1, mood: 0 }]);
		await on(page);

		for (const width of [1280, 390]) {
			await fitsAt(page, `/l/${target.key}`, width, (page) =>
				expect(layer(page).getByTestId('agent-brief')).toBeVisible()
			);
			await fitsAt(page, `/r/${realm.key}/settings`, width, (page) =>
				expect(layer(page).getByTestId('agent-unfiled')).toBeVisible()
			);
			await fitsAt(page, '/account', width, (page) =>
				expect(layer(page).getByTestId('agent-affinity')).toBeVisible()
			);
		}
	});

	test('a User created after the page loaded shows by name', async ({ page, ui }) => {
		const { target } = seeded(ui);
		await on(page);
		await page.goto(`/l/${target.key}`);
		await expect(layer(page).getByTestId('agent-brief')).toBeVisible();

		const scout = ui.agent(uniqueName('scout'), 'Scout Bot');
		ui.join(target.realmId, scout.id);
		ui.appraiseAs(scout.id, [{ labourId: target.id, brief: 'Rewritten by the scout.' }]);
		await layer(page).getByRole('button', { name: 'Refresh' }).click();
		const brief = layer(page).getByRole('region', { name: 'Brief' });
		await expect(brief).toContainText('Rewritten by the scout.');
		await expect(brief).toContainText('Scout Bot');
		await expect(brief).not.toContainText('Someone');
	});

	test('the board renders the same with the switch on and off', async ({ page, ui }) => {
		const { realm } = seeded(ui);
		ui.labour(realm.id, { title: 'Second card' });
		const requests = watchAgentRequests(page);

		const read = async () => {
			await expect(page.locator('[data-card]:not([inert])').first()).toBeVisible();
			return {
				columns: await page.getByTestId('column').allInnerTexts(),
				cards: await page.locator('[data-card]:not([inert])').count()
			};
		};
		await page.goto(`/r/${realm.key}`);
		const off = await read();
		expect(off.cards).toBe(3);

		await toggle(page).click();
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
		expect(await read()).toEqual(off);
		await page.reload();
		await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
		expect(await read()).toEqual(off);
		await expect(layer(page)).toHaveCount(0);
		expect(requests).toEqual([]);
	});
});

test.describe('agent endpoints', () => {
	const paths = (ids: { labour: number; realm: number }) => [
		`/api/agent/labours/${ids.labour}`,
		`/api/agent/realms/${ids.realm}`,
		'/api/agent/me'
	];

	test('answer a session and turn away an API token and no credential', async ({
		page,
		request,
		ui,
		apiToken
	}) => {
		const { realm, target } = seeded(ui);
		for (const path of paths({ labour: target.id, realm: realm.id })) {
			const ok = await page.request.get(path);
			expect(ok.status(), path).toBe(200);

			const withToken = await getNoFollow(request, path, {
				authorization: `Bearer ${apiToken.token}`
			});
			expect(withToken.status(), path).toBe(401);
			expect(await withToken.json()).toEqual({ error: 'unauthorized' });

			const anonymous = await getNoFollow(request, path);
			expect(anonymous.status(), path).toBe(401);
		}
	});

	test('answer 404 for what does not exist', async ({ page }) => {
		for (const path of [
			'/api/agent/labours/999999',
			'/api/agent/realms/999999',
			'/api/agent/labours/x'
		]) {
			const response = await page.request.get(path);
			expect(response.status(), path).toBe(404);
			expect(await response.json()).toEqual({ error: 'not found' });
		}
	});
});
