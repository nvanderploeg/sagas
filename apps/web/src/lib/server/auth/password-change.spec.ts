import { describe, expect, it } from 'vitest';
import { testDb } from '#lib/server/test/db.ts';
import { gate } from './access.ts';
import { createSession, resolveSession } from './sessions.ts';
import { authenticate, changePassword, hasUsers, seedAdmin } from './users.ts';

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
