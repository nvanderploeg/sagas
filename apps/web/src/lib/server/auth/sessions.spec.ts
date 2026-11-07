import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { sessions } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createSession, deleteSession, resolveSession } from './sessions.ts';
import { createFirstAdmin, type AuthUser } from './users.ts';

let db: Db;
let admin: AuthUser;

beforeEach(async () => {
	db = await testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
});

describe('sessions', () => {
	it('resolves a session token to its User', async () => {
		const { token } = await createSession(db, admin.id);

		expect((await resolveSession(db, token))?.id).toBe(admin.id);
	});

	it('stores a hash of the token, never the token', async () => {
		const { token } = await createSession(db, admin.id);

		const ids = (await db.select({ id: sessions.id }).from(sessions)).map((row) => row.id);

		expect(ids).toHaveLength(1);
		expect(ids[0]).not.toBe(token);
		expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
	});

	it('expires after 30 days and removes the expired row', async () => {
		const start = new Date('2026-01-01T00:00:00Z');
		const { token, expiresAt } = await createSession(db, admin.id, start);

		expect((await resolveSession(db, token, new Date(expiresAt.getTime() - 1)))?.id).toBe(admin.id);
		expect(await resolveSession(db, token, expiresAt)).toBeNull();
		expect(await db.select().from(sessions)).toEqual([]);
	});

	it('ends with deleteSession', async () => {
		const { token } = await createSession(db, admin.id);

		await deleteSession(db, token);

		expect(await resolveSession(db, token)).toBeNull();
	});

	it('rejects an unknown token', async () => {
		expect(await resolveSession(db, 'wls_unknown')).toBeNull();
	});
});
