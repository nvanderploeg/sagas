import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { invites, users } from '#lib/server/db/schema.ts';
import { seedHuman } from './fixtures.ts';
import { hashPassword } from './password.ts';
import { testDb } from '#lib/server/test/db.ts';
import { gate } from './access.ts';
import { createSession, resolveSession } from './sessions.ts';
import {
	DELETED_USERNAME,
	authenticate,
	findUser,
	findUserByName,
	changePassword,
	hasUsers,
	deleteUser,
	resetPassword,
	seedAdmin,
	setBanned
} from './users.ts';

describe('seedAdmin', () => {
	it('creates an Admin who must change the password, unless that username exists', async () => {
		const db = await testDb();
		const admin = await seedAdmin(db, { username: 'Boss', password: 'changeme' });
		expect(admin).toMatchObject({ username: 'boss', isAdmin: true, mustChangePassword: true });
		expect(await authenticate(db, 'boss', 'changeme')).not.toBeNull();

		expect(await seedAdmin(db, { username: 'boss', password: 'other-pw' })).toBeNull();
		expect(await authenticate(db, 'boss', 'changeme')).not.toBeNull();

		expect(await seedAdmin(db, { username: 'other', password: 'changeme' })).toMatchObject({
			username: 'other',
			isAdmin: true
		});
		expect(await hasUsers(db)).toBe(true);
	});
});

describe('changePassword', () => {
	async function seeded() {
		const db = await testDb();
		const admin = (await seedAdmin(db, { username: 'boss', password: 'changeme' }))!;
		return { db, admin };
	}

	it('sets the new password, clears the flag and ends the other sessions', async () => {
		const { db, admin } = await seeded();
		const here = await createSession(db, admin.id);
		const elsewhere = await createSession(db, admin.id);
		const hash = (await import('./secrets.ts')).hashSecret(here.token);

		await changePassword(db, admin, {
			current: 'changeme',
			next: 'a-better-one',
			keepSessionId: hash
		});

		expect(await authenticate(db, 'boss', 'changeme')).toBeNull();
		expect(await authenticate(db, 'boss', 'a-better-one')).toMatchObject({
			mustChangePassword: false
		});
		expect(await resolveSession(db, here.token)).not.toBeNull();
		expect(await resolveSession(db, elsewhere.token)).toBeNull();
	});

	it('refuses a wrong current password, an unchanged password and a short one', async () => {
		const { db, admin } = await seeded();
		const change = (current: string, next: string) =>
			changePassword(db, admin, { current, next, keepSessionId: '' });
		await expect(change('wrong', 'a-better-one')).rejects.toThrow('Current password is wrong');
		await expect(change('changeme', 'changeme')).rejects.toThrow('must differ');
		await expect(change('changeme', 'short')).rejects.toThrow('Password must be');
		expect(await authenticate(db, 'boss', 'changeme')).not.toBeNull();
	});
});

describe('gate while a password change is due', () => {
	const due = { setupDone: true, signedIn: true, mustChangePassword: true };

	it('lets only the password page and sign-out through', () => {
		expect(gate('/password', due)).toBe('pass');
		expect(gate('/logout', due)).toBe('pass');
		expect(gate('/', due)).toBe('password');
		expect(gate('/admin', due)).toBe('password');
	});

	it('refuses machine calls with 401', () => {
		expect(gate('/mcp', due)).toBe('unauthorized');
		expect(gate('/api/events', due)).toBe('unauthorized');
	});
});

describe('resetPassword', () => {
	async function twoUsers() {
		const db = await testDb();
		const admin = (await seedAdmin(db, { username: 'boss', password: 'changeme' }))!;
		const worker = await seedHuman(db, 'worker');
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('oldpass1') })
			.where(eq(users.id, worker.id));
		return { db, admin, worker };
	}

	it('sets a temporary password, forces a change and ends their sessions', async () => {
		const { db, admin, worker } = await twoUsers();
		const session = await createSession(db, worker.id);

		const { password } = await resetPassword(db, admin, worker.id);

		expect(await authenticate(db, 'worker', 'oldpass1')).toBeNull();
		expect(await authenticate(db, 'worker', password)).toMatchObject({ mustChangePassword: true });
		expect(await resolveSession(db, session.token)).toBeNull();
	});

	it('is for Admins, other humans only', async () => {
		const { db, admin, worker } = await twoUsers();
		await expect(resetPassword(db, worker, admin.id)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(resetPassword(db, admin, admin.id)).rejects.toMatchObject({ code: 'invalid' });
		await expect(resetPassword(db, admin, 99999)).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('setBanned and deleteUser', () => {
	async function fixture() {
		const db = await testDb();
		const admin = (await seedAdmin(db, { username: 'boss', password: 'changeme' }))!;
		const worker = await seedHuman(db, 'worker');
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('oldpass1') })
			.where(eq(users.id, worker.id));
		return { db, admin, worker };
	}

	it('a ban ends sessions and blocks sign-in until lifted', async () => {
		const { db, admin, worker } = await fixture();
		const session = await createSession(db, worker.id);

		await setBanned(db, admin, { userId: worker.id, banned: true, confirm: 'worker' });

		expect(await resolveSession(db, session.token)).toBeNull();
		expect(await authenticate(db, 'worker', 'oldpass1')).toBeNull();

		await setBanned(db, admin, { userId: worker.id, banned: false, confirm: 'worker' });
		expect(await authenticate(db, 'worker', 'oldpass1')).not.toBeNull();
	});

	it('needs the username typed, an Admin, and someone else', async () => {
		const { db, admin, worker } = await fixture();
		const input = { userId: worker.id, banned: true };
		await expect(setBanned(db, admin, { ...input, confirm: 'nope' })).rejects.toMatchObject({
			code: 'invalid'
		});
		await expect(setBanned(db, worker, { ...input, confirm: 'worker' })).rejects.toMatchObject({
			code: 'forbidden'
		});
		await expect(
			setBanned(db, admin, { userId: admin.id, banned: true, confirm: 'boss' })
		).rejects.toMatchObject({ code: 'invalid' });
		await expect(deleteUser(db, admin, { userId: worker.id, confirm: 'x' })).rejects.toMatchObject({
			code: 'invalid'
		});
	});

	it('deletes a User with no history', async () => {
		const { db, admin, worker } = await fixture();
		await createSession(db, worker.id);

		await deleteUser(db, admin, { userId: worker.id, confirm: 'worker' });

		expect(await authenticate(db, 'worker', 'oldpass1')).toBeNull();
		await expect(
			deleteUser(db, admin, { userId: worker.id, confirm: 'worker' })
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('deletes a User who has history, handing it to the Deleted user', async () => {
		const { db, admin } = await fixture();
		const other = await seedHuman(db, 'other');
		await db.insert(invites).values({ tokenHash: 'h', createdByUserId: other.id });

		await deleteUser(db, admin, { userId: other.id, confirm: 'other' });

		const stand = (await findUserByName(db, DELETED_USERNAME))!;
		const invite = (await db.select().from(invites))[0];
		expect(invite.createdByUserId).toBe(stand.id);
		expect(await findUser(db, other.id)).toBeNull();
	});
});
