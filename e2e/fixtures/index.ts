/* eslint-disable no-empty-pattern */
import {
	test as base,
	expect,
	type APIRequestContext,
	type APIResponse,
	type BrowserContext,
	type Page
} from '@playwright/test';
import { adminEmail } from '../support/env.ts';
import { postJson } from '../support/http.ts';
import { idToken } from '../support/firebase.ts';
import {
	loadSeedKit,
	type SeedKit,
	type Db,
	type IssuedToken,
	type Seed
} from '../support/seed.ts';

export type Admin = {
	id: number;
	username: string;
	displayName: string;
	email: string;
};

// Trades a fresh Firebase ID token for a session cookie, as the sign-in page does.
export async function exchangeSession(
	request: APIRequestContext,
	email: string
): Promise<APIResponse> {
	return postJson(request, '/api/auth/session', { idToken: await idToken(email) });
}

export async function signInContext(context: BrowserContext, email: string): Promise<void> {
	const response = await exchangeSession(context.request, email);
	expect(response.status(), await response.text()).toBe(200);
}

type Fixtures = {
	seed: Seed;
	apiToken: IssuedToken;
	signedInPage: Page;
};

type WorkerFixtures = {
	kit: SeedKit;
	db: Db;
	admin: Admin;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
	kit: [
		async ({}, use) => {
			const loaded = await loadSeedKit();
			await use(loaded.kit);
			await loaded.close();
		},
		{ scope: 'worker' }
	],

	db: [
		async ({ kit }, use) => {
			const db = kit.openRunDb();
			await use(db);
			await db.$client.end();
		},
		{ scope: 'worker' }
	],

	// The Admin the run's ADMIN_EMAILS names; its first session links the Firebase account to this row.
	admin: [
		async ({ kit, db }, use) => {
			const username = 'e2eadmin';
			const displayName = 'E2E Admin';
			const id = await kit.ensureAdmin(db, { username, displayName, email: adminEmail });
			await use({ id, username, displayName, email: adminEmail });
		},
		{ scope: 'worker' }
	],

	seed: async ({ kit, db, admin }, use) => {
		await use(await kit.createSeed(db, admin.id));
	},

	// A fresh token for the Admin; revoked by the test or left to die with the run.
	apiToken: async ({ seed }, use) => {
		await use(await seed.apiToken());
	},

	signedInPage: async ({ page, admin }, use) => {
		await signInContext(page.context(), admin.email);
		await use(page);
	}
});

export { expect };
