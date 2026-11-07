import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { apiTokens } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { hashSecret } from './secrets.ts';
import { completeSetup } from './setup.ts';
import { verifyApiToken } from './tokens.ts';
import { authenticate, hasUsers } from './users.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

const input = { username: 'Root', displayName: 'Root', password: 'a long enough password' };

describe('completeSetup', () => {
	it('creates the first Admin, who can then sign in', async () => {
		const { admin } = await completeSetup(db, input);

		expect(admin).toMatchObject({ kind: 'human', isAdmin: true, username: 'root' });
		expect((await authenticate(db, 'root', input.password))?.id).toBe(admin.id);
	});

	it('issues the first Admin one API token and keeps only its hash', async () => {
		const { admin, token } = await completeSetup(db, input);

		const rows = await db.select().from(apiTokens);

		expect(token).toMatch(/^wlt_/);
		expect((await verifyApiToken(db, token))?.id).toBe(admin.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ userId: admin.id, tokenHash: hashSecret(token) });
		expect(JSON.stringify(rows)).not.toContain(token);
	});

	it('runs once', async () => {
		await completeSetup(db, input);

		await expect(completeSetup(db, { ...input, username: 'second' })).rejects.toMatchObject({
			code: 'conflict'
		});
		expect(await db.select().from(apiTokens)).toHaveLength(1);
	});

	it('creates neither an Admin nor a token when the input is invalid', async () => {
		await expect(completeSetup(db, { ...input, password: 'short' })).rejects.toMatchObject({
			code: 'invalid'
		});

		expect(await hasUsers(db)).toBe(false);
		expect(await db.select().from(apiTokens)).toEqual([]);
	});
});
