import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realms, users } from '#lib/server/db/schema.ts';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { credentialValid, sessionCredential } from './credentials.ts';
import { setSessionVerifier } from './firebase.ts';
import { fakeSessions, seedAdmin, seedHuman } from './fixtures.ts';
import {
	createAgentUser,
	DELETED_USERNAME,
	deleteUser,
	listUsers,
	setBanned,
	setRealmLimit,
	setUserEmail,
	unlinkSignIn
} from './users.ts';

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

	it('refuses to set a limit on an Agent user', async () => {
		const admin = await seedAdmin(db);
		const agent = await createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });

		await expectCode(() => setRealmLimit(db, admin, agent.id, 3), 'invalid');
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

afterEach(() => setSessionVerifier(null));

describe('unlinkSignIn', () => {
	it("revokes the unlinked uid's Firebase sessions", async () => {
		const revoke = vi.fn(() => Promise.resolve());
		setSessionVerifier({
			exchange: () => Promise.resolve(null),
			verify: () => Promise.resolve(null),
			revoke
		});
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		await db.update(users).set({ firebaseUid: 'g' }).where(eq(users.id, grace.id));

		await unlinkSignIn(db, admin, grace.id);

		expect(revoke).toHaveBeenCalledWith('g');
	});

	it('clears the uid but keeps the email, for an Admin only', async () => {
		fakeSessions();
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		await db
			.update(users)
			.set({ firebaseUid: 'g', email: 'grace@x.test' })
			.where(eq(users.id, grace.id));

		await expectCode(() => unlinkSignIn(db, grace, grace.id), 'forbidden');
		await expectCode(() => unlinkSignIn(db, admin, 9999), 'not_found');
		expect((await unlinkSignIn(db, admin, grace.id)).email).toBe('grace@x.test');
		const row = (await db.select().from(users).where(eq(users.id, grace.id)))[0];
		expect(row.firebaseUid).toBeNull();
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

describe('setUserEmail', () => {
	it('refuses an Agent user', async () => {
		const admin = await seedAdmin(db);
		const bot = await createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });

		await expectCode(() => setUserEmail(db, admin, bot.id, 'bot@x.test'), 'invalid');
	});
});

describe('deleteUser', () => {
	it('hands the Realms the User created to the Deleted user', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		const realm = (
			await db
				.insert(realms)
				.values({ name: 'R', key: 'RR', createdByUserId: grace.id })
				.returning()
		)[0];

		await deleteUser(db, admin, { userId: grace.id, confirm: 'grace' });

		const stand = (await db.select().from(users).where(eq(users.username, DELETED_USERNAME)))[0];
		const after = (await db.select().from(realms).where(eq(realms.id, realm.id)))[0];
		expect(after.createdByUserId).toBe(stand.id);
	});

	it('does not mistake a human named deleted-user for the stand-in', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		await db.update(users).set({ username: DELETED_USERNAME }).where(eq(users.id, grace.id));

		await expectCode(
			() => deleteUser(db, admin, { userId: grace.id, confirm: DELETED_USERNAME }),
			'invalid'
		);
	});
});

describe('a banned User', () => {
	it('keeps the ban when Firebase cannot revoke, and ends the live session credential', async () => {
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const sessions = fakeSessions();
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		const cookie = await sessions.open(db, grace);
		expect(await credentialValid(db, sessionCredential(cookie))).toBe(true);

		setSessionVerifier({
			exchange: () => Promise.resolve(null),
			verify: () =>
				Promise.resolve({ uid: `uid-${grace.id}`, email: null, emailVerified: true, name: null }),
			revoke: () => Promise.reject(new Error('down'))
		});
		await setBanned(db, admin, { userId: grace.id, banned: true, confirm: 'grace' });

		expect(quiet).toHaveBeenCalled();
		quiet.mockRestore();
		expect(await credentialValid(db, sessionCredential(cookie))).toBe(false);
	});
});
