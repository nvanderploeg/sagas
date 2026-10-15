import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { sessions } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createSession, deleteSession, resolveSession } from './sessions.ts';
import { createFirstAdmin, type AuthUser } from './users.ts';

let db: Db;
let admin: AuthUser;

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
});

afterEach(() => {
	db.$client.close();
});

describe('sessions', () => {
	it('resolves a session token to its User', () => {
		const { token } = createSession(db, admin.id);

		expect(resolveSession(db, token)?.id).toBe(admin.id);
	});

	it('stores a hash of the token, never the token', () => {
		const { token } = createSession(db, admin.id);

		const ids = db
			.select({ id: sessions.id })
			.from(sessions)
			.all()
			.map((row) => row.id);

		expect(ids).toHaveLength(1);
		expect(ids[0]).not.toBe(token);
		expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
	});

	it('expires after 30 days and removes the expired row', () => {
		const start = new Date('2026-01-01T00:00:00Z');
		const { token, expiresAt } = createSession(db, admin.id, start);

		expect(resolveSession(db, token, new Date(expiresAt.getTime() - 1))?.id).toBe(admin.id);
		expect(resolveSession(db, token, expiresAt)).toBeNull();
		expect(db.select().from(sessions).all()).toEqual([]);
	});

	it('ends with deleteSession', () => {
		const { token } = createSession(db, admin.id);

		deleteSession(db, token);

		expect(resolveSession(db, token)).toBeNull();
	});

	it('rejects an unknown token', () => {
		expect(resolveSession(db, 'wls_unknown')).toBeNull();
	});
});
