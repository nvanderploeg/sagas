/* eslint-disable no-empty-pattern */
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { createServer } from 'vite';
import { origin } from '../support/env.ts';
import { postForm, uniqueName } from '../support/http.ts';
import { expect, test as base } from './index.ts';

type UiKit = typeof import('../support/ui-seed-impl.ts');
export type UiSeed = import('../support/ui-seed-impl.ts').UiSeed;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export type Person = { id: number; username: string; displayName: string; password: string };

type Fixtures = {
	ui: UiSeed;
	page: Page;
	// A second human User, signed in in a browser context of its own.
	other: { person: Person; context: BrowserContext; page: Page };
};

type WorkerFixtures = { uiKit: UiKit };

const PASSWORD = 'a long enough password';

export async function signIn(
	browser: Browser,
	username: string,
	password: string
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ baseURL: origin });
	const response = await postForm(context.request, '/login', { username, password });
	expect(response.status()).toBe(303);
	return { context, page: await context.newPage() };
}

export const test = base.extend<Fixtures, WorkerFixtures>({
	uiKit: [
		async ({}, use) => {
			const server = await createServer({
				root: repoRoot,
				configFile: false,
				appType: 'custom',
				logLevel: 'error',
				server: {
					middlewareMode: true,
					hmr: false,
					ws: false,
					watch: null,
					fs: { strict: false }
				},
				optimizeDeps: { noDiscovery: true, include: [] }
			});
			await use((await server.ssrLoadModule('/e2e/support/ui-seed-impl.ts')) as UiKit);
			await server.close();
		},
		{ scope: 'worker' }
	],

	ui: async ({ uiKit, db, admin }, use) => {
		await use(uiKit.createUiSeed(db, admin.id));
	},

	// Every UI spec starts signed in as the Admin.
	page: async ({ page, admin }, use) => {
		const response = await postForm(page.request, '/login', {
			username: admin.username,
			password: admin.password
		});
		expect(response.status()).toBe(303);
		await use(page);
	},

	other: async ({ ui, browser }, use) => {
		const username = uniqueName('pat');
		const user = await ui.human(username, 'Pat Partner', PASSWORD);
		const { context, page } = await signIn(browser, username, PASSWORD);
		await use({
			person: { id: user.id, username, displayName: 'Pat Partner', password: PASSWORD },
			context,
			page
		});
		await context.close();
	}
});

export { expect };

export function column(page: Page, label: string): Locator {
	return page.locator(`[data-testid="column"][data-state="${label}"]`);
}

// Svelte marks a card that is animating out `inert`; only the settled cards count.
export function card(page: Page, key: string): Locator {
	return page
		.locator('[data-card]:not([inert])')
		.filter({ has: page.locator(`a[href="/l/${key}"]`) });
}

export async function cardKeys(lane: Locator): Promise<string[]> {
	return lane.locator('[data-card]:not([inert]) .key').allTextContents();
}

// Drags with real pointer events: press, travel in steps past the drag threshold, release.
export async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
	const box = (await from.boundingBox())!;
	const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 4, start.y + 8, { steps: 2 });
	await page.mouse.move(to.x, to.y, { steps: 12 });
	await page.waitForTimeout(120);
	await page.mouse.move(to.x, to.y + 1, { steps: 2 });
	await page.mouse.up();
}

// The live Stream is open, so writes from elsewhere arrive without a reload.
export async function live(page: Page) {
	await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'live');
}

// Holds back every answer to a request `match` picks for `ms`.
export async function hold(page: Page, match: (url: URL) => boolean, ms: number) {
	await page.route(match, async (route) => {
		const response = await route.fetch();
		await new Promise((resolve) => setTimeout(resolve, ms));
		await route.fulfill({ response });
	});
}

// Holds back the answer to the form action `name`, so the write's own Events reach the page
// before its answer does.
export const holdAction = (page: Page, name: string, ms = 400) =>
	hold(page, (url) => url.search === `?/${name}`, ms);

// Holds back every page data load, such as the reload a view asks for.
export const holdLoads = (page: Page, ms = 800) =>
	hold(page, (url) => url.pathname.endsWith('/__data.json'), ms);

let records = 0;

// Records every text `selector` shows from now on, in order, without repeats; `(none)` while
// nothing matches.
export async function recordText(page: Page, selector: string): Promise<() => Promise<string[]>> {
	const key = `__record${++records}`;
	await page.evaluate(
		({ selector, key }) => {
			const seen: string[] = [];
			(window as unknown as Record<string, string[]>)[key] = seen;
			const read = () => {
				const element = document.querySelector(selector);
				const text = element ? (element.textContent ?? '').replace(/\s+/g, ' ').trim() : '(none)';
				if (seen.at(-1) !== text) seen.push(text);
			};
			read();
			new MutationObserver(read).observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true
			});
		},
		{ selector, key }
	);
	return () => page.evaluate((key) => (window as unknown as Record<string, string[]>)[key], key);
}
