/* eslint-disable no-empty-pattern */
import { readFileSync } from 'node:fs';
import { test as base, expect, type Page } from '@playwright/test';
import { adminFile } from '../support/env.ts';
import { postForm } from '../support/http.ts';
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
	password: string;
	setupToken: string;
};

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

	// The first Admin, created by setup.e2e.ts, which every other spec depends on.
	admin: [
		async ({ db }, use) => {
			const saved = JSON.parse(readFileSync(adminFile, 'utf8')) as Omit<Admin, 'id'>;
			const row = (
				await db.$client.query<{ id: number }>('SELECT id FROM users WHERE username = $1', [
					saved.username
				])
			).rows[0];
			await use({ ...saved, id: row.id });
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
		const response = await postForm(page.request, '/login', {
			username: admin.username,
			password: admin.password
		});
		expect(response.status()).toBe(303);
		await use(page);
	}
});

export { expect };
