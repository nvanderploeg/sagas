import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { realmMembers, realms, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { acceptOffer, offerMembership } from '#lib/server/domain/memberships.ts';
import { setAccessEnforced, visibleRealmIds } from '#lib/server/domain/access.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
import { testDb } from '#lib/server/test/db.ts';
import { TODO } from '#lib/server/test/fixtures.ts';
import { seedAdmin, seedHuman } from './fixtures.ts';
import { assignRealmOwner } from './realm-owners.ts';
import { createAgentUser } from './users.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

async function code(action: () => unknown) {
	try {
		await action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	return 'ok';
}

const membership = async (realmId: number, userId: number) =>
	(
		await db
			.select()
			.from(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
	)[0];

describe('assignRealmOwner', () => {
	it('adds a non-member as an active Owner and leaves the creator and existing Owners', async () => {
		const admin = await seedAdmin(db);
		const ada = await seedHuman(db, 'ada');
		const bob = await seedHuman(db, 'bob');
		const realm = await createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO });

		await assignRealmOwner(db, admin, { realmKey: 'am', user: 'Bob' });

		expect(await membership(realm.id, bob.id)).toMatchObject({ role: 'owner', status: 'active' });
		expect(await membership(realm.id, ada.id)).toMatchObject({ role: 'owner', status: 'active' });
		const row = (await db.select().from(realms).where(eq(realms.id, realm.id)))[0];
		expect(row.createdByUserId).toBe(ada.id);
	});

	it('finds the User by email', async () => {
		const admin = await seedAdmin(db);
		const ada = await seedHuman(db, 'ada');
		const bob = await seedHuman(db, 'bob');
		await db.update(users).set({ email: 'bob@example.com' }).where(eq(users.id, bob.id));
		const realm = await createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO });

		await assignRealmOwner(db, admin, { realmKey: 'AM', user: 'Bob@Example.com' });

		expect((await membership(realm.id, bob.id))?.role).toBe('owner');
	});

	it('promotes an editor and turns a pending Offer into an active Owner', async () => {
		const admin = await seedAdmin(db);
		const ada = await seedHuman(db, 'ada');
		const bob = await seedHuman(db, 'bob');
		const cy = await seedHuman(db, 'cy');
		const realm = await createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO });
		await offerMembership(db, ada, realm.id, bob.id, 'editor');
		await acceptOffer(db, bob, realm.id);
		await offerMembership(db, ada, realm.id, cy.id, 'viewer');

		await assignRealmOwner(db, admin, { realmKey: 'AM', user: 'bob' });
		await assignRealmOwner(db, admin, { realmKey: 'AM', user: 'cy' });

		expect(await membership(realm.id, bob.id)).toMatchObject({ role: 'owner', status: 'active' });
		expect(await membership(realm.id, cy.id)).toMatchObject({ role: 'owner', status: 'active' });
		expect((await membership(realm.id, cy.id))?.acceptedAt).not.toBeNull();
	});

	it('lets an Admin assign an Owner without reading the Realm', async () => {
		setAccessEnforced(true);
		try {
			const admin = await seedAdmin(db);
			const ada = await seedHuman(db, 'ada');
			const bob = await seedHuman(db, 'bob');
			const realm = await createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO });

			await assignRealmOwner(db, admin, { realmKey: 'AM', user: 'bob' });

			expect(await visibleRealmIds(db, admin)).toEqual([]);
			expect(await visibleRealmIds(db, bob)).toEqual([realm.id]);
		} finally {
			setAccessEnforced(false);
		}
	});

	it('allows an Agent user, and refuses a non-Admin, an unknown Realm and an unknown User', async () => {
		const admin = await seedAdmin(db);
		const ada = await seedHuman(db, 'ada');
		const bot = await createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });
		const realm = await createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO });

		await assignRealmOwner(db, admin, { realmKey: 'AM', user: 'bot' });
		expect((await membership(realm.id, bot.id))?.role).toBe('owner');

		expect(await code(() => assignRealmOwner(db, ada, { realmKey: 'AM', user: 'ada' }))).toBe(
			'forbidden'
		);
		expect(await code(() => assignRealmOwner(db, admin, { realmKey: 'ZZ', user: 'ada' }))).toBe(
			'not_found'
		);
		expect(await code(() => assignRealmOwner(db, admin, { realmKey: 'AM', user: 'nobody' }))).toBe(
			'not_found'
		);
		expect(await code(() => assignRealmOwner(db, admin, { realmKey: 'A', user: 'ada' }))).toBe(
			'invalid'
		);
	});
});
