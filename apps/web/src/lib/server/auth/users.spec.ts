import { beforeEach, describe, expect, it } from 'vitest';
import { users } from '#lib/server/db/schema.ts';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { seedAdmin, seedHuman } from './fixtures.ts';
import { createAgentUser, listUsers, setRealmLimit, setUserEmail } from './users.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

async function expectCode(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

describe('Agent users', () => {
	it('creates an Agent user, and an Admin only', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');

		const bot = await createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });

		expect(bot).toMatchObject({ kind: 'agent', isAdmin: false });
		await expectCode(
			() => createAgentUser(db, grace, { username: 'other', displayName: 'Other' }),
			'forbidden'
		);
	});

	it('rejects a username already taken', async () => {
		const admin = await seedAdmin(db);

		await expectCode(
			() => createAgentUser(db, admin, { username: 'ROOT', displayName: 'Dup' }),
			'conflict'
		);
	});
});

describe('realm limit', () => {
	it('starts every User at 1 and lets only an Admin change it', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		const fresh = (
			await db
				.insert(users)
				.values({ kind: 'human', username: 'new', displayName: 'New' })
				.returning()
		)[0];
		expect(fresh.realmLimit).toBe(1);

		expect((await setRealmLimit(db, admin, grace.id, 3)).realmLimit).toBe(3);
		await expectCode(() => setRealmLimit(db, grace, grace.id, 9), 'forbidden');
	});

	it('rejects a negative or fractional limit and an unknown User', async () => {
		const admin = await seedAdmin(db);

		await expectCode(() => setRealmLimit(db, admin, admin.id, -1), 'invalid');
		await expectCode(() => setRealmLimit(db, admin, admin.id, 1.5), 'invalid');
		await expectCode(() => setRealmLimit(db, admin, 9999, 1), 'not_found');
	});
});

describe('user email', () => {
	it('stores it lowercase, clears it when empty, and refuses a duplicate', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');

		expect((await setUserEmail(db, admin, grace.id, ' Grace@X.test ')).email).toBe('grace@x.test');
		await expectCode(() => setUserEmail(db, admin, admin.id, 'grace@x.test'), 'conflict');
		expect((await setUserEmail(db, admin, grace.id, '')).email).toBeNull();
		await expectCode(() => setUserEmail(db, admin, grace.id, 'nope'), 'invalid');
		await expectCode(() => setUserEmail(db, grace, grace.id, 'g@x.test'), 'forbidden');
	});
});

describe('listing users', () => {
	it('lists humans and agents by display name', async () => {
		const root = await seedAdmin(db);
		await createAgentUser(db, root, { username: 'bot', displayName: 'Atlas' });
		await seedHuman(db, 'zed');

		expect((await listUsers(db)).map((u) => [u.username, u.kind])).toEqual([
			['bot', 'agent'],
			['root', 'human'],
			['zed', 'human']
		]);
	});
});
