import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { acceptInvite, createInvite, isInviteOpen, listInvites } from './invites.ts';
import { createFirstAdmin, authenticate, type AuthUser } from './users.ts';
import { seedHuman } from './fixtures.ts';

let db: Db;
let admin: AuthUser;

const join = { displayName: 'Ada Lovelace', password: 'a long enough password' };

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

describe('invites', () => {
	it('lets an Admin create an invite, and only an Admin', () => {
		const { token } = createInvite(db, admin);

		expect(isInviteOpen(db, token)).toBe(true);
		expect(() => createInvite(db, seedHuman(db, 'grace'))).toThrow(DomainError);
	});

	it('creates a human, non-Admin User who can then sign in with the chosen password', async () => {
		const { token } = createInvite(db, admin);

		const ada = await acceptInvite(db, token, { username: 'Ada', ...join });

		expect(ada).toMatchObject({ kind: 'human', isAdmin: false, username: 'ada' });
		expect((await authenticate(db, 'ada', join.password))?.id).toBe(ada.id);
	});

	it('is single-use', async () => {
		const { token } = createInvite(db, admin);
		await acceptInvite(db, token, { username: 'ada', ...join });

		expect(isInviteOpen(db, token)).toBe(false);
		await expect(acceptInvite(db, token, { username: 'second', ...join })).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('rejects an unknown token', async () => {
		await expect(
			acceptInvite(db, 'wli_unknown', { username: 'ada', ...join })
		).rejects.toMatchObject({ code: 'not_found' });
		expect(isInviteOpen(db, 'wli_unknown')).toBe(false);
	});

	it('keeps the invite open when the username is taken', async () => {
		const { token } = createInvite(db, admin);

		await expect(acceptInvite(db, token, { username: 'root', ...join })).rejects.toMatchObject({
			code: 'conflict'
		});
		expect(isInviteOpen(db, token)).toBe(true);
	});

	it('rejects a weak password and keeps the invite open', async () => {
		const { token } = createInvite(db, admin);

		await expect(
			acceptInvite(db, token, { username: 'ada', displayName: 'Ada', password: 'short' })
		).rejects.toMatchObject({ code: 'invalid' });
		expect(isInviteOpen(db, token)).toBe(true);
	});
});

describe('listing invites', () => {
	it('lists open and used invites to an Admin', async () => {
		const open = createInvite(db, admin);
		const used = createInvite(db, admin);
		await acceptInvite(db, used.token, { ...join, username: 'ada' });

		const listed = listInvites(db, admin);

		expect(listed.map((i) => [i.id, i.usedAt !== null])).toEqual([
			[open.id, false],
			[used.id, true]
		]);
		expect(JSON.stringify(listed)).not.toContain(open.token);
	});

	it('refuses a non-Admin', () => {
		const ada = seedHuman(db, 'ada');
		expect(() => listInvites(db, ada)).toThrow(DomainError);
	});
});
