import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createAgentUser, setUserEmail, unlinkSignIn } from './users.ts';
import { seedAdmin, seedHuman } from './fixtures.ts';
import type { FirebaseIdentity } from './firebase.ts';
import { signInIdentity } from './signin.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

const identity = (over: Partial<FirebaseIdentity> = {}): FirebaseIdentity => ({
	uid: 'uid-1',
	email: 'ada.lovelace@example.com',
	emailVerified: true,
	name: 'Ada Lovelace',
	...over
});
const none = new Set<string>();

describe('signInIdentity', () => {
	it('creates a human User with a username from the email', async () => {
		const user = await signInIdentity(db, identity(), none);

		expect(user).toMatchObject({
			kind: 'human',
			isAdmin: false,
			username: 'adalovelace',
			displayName: 'Ada Lovelace',
			email: 'ada.lovelace@example.com',
			realmLimit: 1
		});
	});

	it('returns the same User on every later sign-in', async () => {
		const first = await signInIdentity(db, identity(), none);
		const again = await signInIdentity(db, identity(), none);

		expect(again.id).toBe(first.id);
	});

	it('suffixes a username that is taken', async () => {
		await seedHuman(db, 'ada');
		const user = await signInIdentity(db, identity({ email: 'ada@example.com' }), none);

		expect(user.username).toBe('ada2');
	});

	it('links a first sign-in to the User holding that verified email', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		await setUserEmail(db, admin, grace.id, 'grace@example.com');

		const user = await signInIdentity(
			db,
			identity({ uid: 'g', email: 'grace@example.com', name: null }),
			none
		);

		expect(user.id).toBe(grace.id);
		expect(user.username).toBe('grace');
	});

	it('refuses an email that is not verified, or missing', async () => {
		await expect(
			signInIdentity(db, identity({ emailVerified: false }), none)
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(signInIdentity(db, identity({ email: null }), none)).rejects.toMatchObject({
			code: 'forbidden'
		});
	});

	it('refuses to link an Agent user holding the email', async () => {
		const admin = await seedAdmin(db);
		const bot = await createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });
		await db.update(users).set({ email: 'bot@example.com' }).where(eq(users.id, bot.id));

		await expect(
			signInIdentity(db, identity({ email: 'bot@example.com' }), none)
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('makes a listed admin email an Admin, on creation and on a later link', async () => {
		const listed = new Set(['ada.lovelace@example.com']);
		expect((await signInIdentity(db, identity(), listed)).isAdmin).toBe(true);

		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		await setUserEmail(db, admin, grace.id, 'grace@example.com');
		const linked = await signInIdentity(
			db,
			identity({ uid: 'g', email: 'grace@example.com' }),
			new Set(['grace@example.com'])
		);
		expect(linked).toMatchObject({ id: grace.id, isAdmin: true });
	});

	it('does not demote an Admin whose email left the list', async () => {
		await signInIdentity(db, identity(), new Set(['ada.lovelace@example.com']));

		expect((await signInIdentity(db, identity(), none)).isAdmin).toBe(true);
	});

	describe('on an instance with Users that predate Firebase', () => {
		const listed = new Set(['ada.lovelace@example.com']);

		it('links a listed admin email to the sole existing human Admin', async () => {
			const old = await seedAdmin(db, 'root', 'Root');
			await createAgentUser(db, old, { username: 'bot', displayName: 'Bot' });
			await seedHuman(db, 'plain');

			const user = await signInIdentity(db, identity(), listed);

			expect(user).toMatchObject({ id: old.id, isAdmin: true, email: 'ada.lovelace@example.com' });
			expect((await signInIdentity(db, identity(), listed)).id).toBe(old.id);
		});

		it('creates a new Admin rather than guess among several unlinked Admins', async () => {
			const a = await seedAdmin(db, 'root', 'Root');
			const b = await seedAdmin(db, 'boss', 'Boss');

			const user = await signInIdentity(db, identity(), listed);

			expect([a.id, b.id]).not.toContain(user.id);
			expect(user.isAdmin).toBe(true);
		});

		it('does not hand the old Admin to a non-listed sign-in', async () => {
			const old = await seedAdmin(db, 'root', 'Root');

			const user = await signInIdentity(db, identity(), none);

			expect(user.id).not.toBe(old.id);
			expect(user.isAdmin).toBe(false);
		});

		it('does not hand the old Admin to a second listed email once someone is linked', async () => {
			const old = await seedAdmin(db, 'root', 'Root');
			const both = new Set(['ada.lovelace@example.com', 'bob@example.com']);
			await signInIdentity(db, identity(), both);

			const bob = await signInIdentity(db, identity({ uid: 'b', email: 'bob@example.com' }), both);

			expect(bob.id).not.toBe(old.id);
		});
	});

	it('gives a conflict when a linked uid signs in with an email another User holds', async () => {
		const admin = await seedAdmin(db);
		const grace = await seedHuman(db, 'grace');
		await setUserEmail(db, admin, grace.id, 'grace@example.com');
		await signInIdentity(db, identity(), none);

		await expect(
			signInIdentity(db, identity({ email: 'grace@example.com' }), none)
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('names the Admin unlink in the conflict for a recreated Firebase account', async () => {
		await signInIdentity(db, identity(), none);

		await expect(signInIdentity(db, identity({ uid: 'uid-new' }), none)).rejects.toThrow(/unlink/);
	});

	it('links a recreated Firebase account after an Admin unlinks the User', async () => {
		const admin = await seedAdmin(db);
		const first = await signInIdentity(db, identity(), none);

		await unlinkSignIn(db, admin, first.id);
		const again = await signInIdentity(db, identity({ uid: 'uid-new' }), none);

		expect(again.id).toBe(first.id);
	});
});
