import { seedAdmin } from './fixtures.ts';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { apiTokens } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createAgentUser, findUser, type AuthUser } from './users.ts';
import { createApiToken, listApiTokens, revokeApiToken, verifyApiToken } from './tokens.ts';
import { apiTokenCredential, credentialValid } from './credentials.ts';
import { hashSecret } from './secrets.ts';
import { seedHuman } from './fixtures.ts';

let db: Db;
let admin: AuthUser;

beforeEach(async () => {
	db = await testDb();
	admin = await seedAdmin(db, 'root', 'Root');
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

describe('API token storage', () => {
	it('stores only the sha256 of the token', async () => {
		const { id, token } = await createApiToken(db, admin, admin.id, 'laptop');

		const row = (await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1))[0]!;

		expect(token.startsWith('wlt_')).toBe(true);
		expect(row.tokenHash).toBe(hashSecret(token));
		expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(row)).not.toContain(token);
	});

	it('gives every token a fresh secret', async () => {
		const first = (await createApiToken(db, admin, admin.id, 'a')).token;
		const second = (await createApiToken(db, admin, admin.id, 'b')).token;

		expect(first).not.toBe(second);
	});
});

describe('API token verification', () => {
	it('resolves the token to the User it was created for and stamps last use', async () => {
		const { id, token } = await createApiToken(db, admin, admin.id, 'laptop');

		expect((await verifyApiToken(db, token))?.id).toBe(admin.id);
		const row = (await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1))[0]!;
		expect(row.lastUsedAt).toBeInstanceOf(Date);
	});

	it('rejects an unknown or altered token', async () => {
		const { token } = await createApiToken(db, admin, admin.id, 'laptop');

		expect(await verifyApiToken(db, 'wlt_unknown')).toBeNull();
		expect(await verifyApiToken(db, token + 'x')).toBeNull();
	});

	it('rejects a revoked token, and revoking twice is harmless', async () => {
		const { id, token } = await createApiToken(db, admin, admin.id, 'laptop');

		await revokeApiToken(db, admin, id);
		await revokeApiToken(db, admin, id);

		expect(await verifyApiToken(db, token)).toBeNull();
	});
});

describe('who may manage a token', () => {
	it('lets an Admin create and revoke tokens for an Agent user', async () => {
		const bot = await createAgentUser(db, admin, { username: 'mcp-bot', displayName: 'MCP' });

		const { id, token } = await createApiToken(db, admin, bot.id, 'mcp');

		expect((await verifyApiToken(db, token))?.id).toBe(bot.id);
		await revokeApiToken(db, admin, id);
		expect(await verifyApiToken(db, token)).toBeNull();
	});

	it('lets a User create a token only for itself', async () => {
		const grace = await seedHuman(db, 'grace');

		expect((await createApiToken(db, grace, grace.id, 'own')).token).toMatch(/^wlt_/);
		await expectCode(() => createApiToken(db, grace, admin.id, 'theirs'), 'forbidden');
	});

	it('stops an Admin creating a token that acts as another human', async () => {
		const grace = await seedHuman(db, 'grace');

		await expectCode(() => createApiToken(db, admin, grace.id, 'impersonate'), 'forbidden');
	});

	it('stops a User revoking another User token', async () => {
		const grace = await seedHuman(db, 'grace');
		const { id } = await createApiToken(db, admin, admin.id, 'root');

		await expectCode(() => revokeApiToken(db, grace, id), 'forbidden');
	});

	it('reports an unknown User as not found when creating a token', async () => {
		await expectCode(() => createApiToken(db, admin, 999, 'ghost'), 'not_found');
	});

	it('rejects a blank token name', async () => {
		await expectCode(() => createApiToken(db, admin, admin.id, '  '), 'invalid');
	});

	it('exposes the User behind a token through findUser', async () => {
		expect((await findUser(db, admin.id))?.username).toBe('root');
	});
});

describe('listing API tokens', () => {
	it('lists a User’s tokens, revoked ones included, without their secrets', async () => {
		const kept = await createApiToken(db, admin, admin.id, 'laptop');
		const gone = await createApiToken(db, admin, admin.id, 'old');
		await revokeApiToken(db, admin, gone.id);

		const listed = await listApiTokens(db, admin, admin.id);

		expect(listed.map((t) => [t.id, t.name, t.revokedAt !== null])).toEqual([
			[kept.id, 'laptop', false],
			[gone.id, 'old', true]
		]);
		expect(JSON.stringify(listed)).not.toContain(kept.token);
	});

	it('refuses to list a human’s tokens to anyone but that human', async () => {
		const ada = await seedHuman(db, 'ada');
		await expectCode(() => listApiTokens(db, admin, ada.id), 'forbidden');
	});

	it('lets an Admin list an Agent user’s tokens', async () => {
		const bot = await createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });
		await createApiToken(db, admin, bot.id, 'mcp');
		expect((await listApiTokens(db, admin, bot.id)).map((t) => t.name)).toEqual(['mcp']);
	});
});

describe('API token expiry', () => {
	const T0 = new Date('2026-01-01T00:00:00Z');
	const expireAt = async (id: number, at: Date | null) =>
		await db.update(apiTokens).set({ expiresAt: at }).where(eq(apiTokens.id, id));

	it('refuses a token from the moment it expires, and credentialValid agrees', async () => {
		const { id, token } = await createApiToken(db, admin, admin.id, 'short');
		await expireAt(id, T0);

		expect((await verifyApiToken(db, token, new Date(T0.getTime() - 1)))?.id).toBe(admin.id);
		expect(await verifyApiToken(db, token, T0)).toBeNull();
		expect(await credentialValid(db, apiTokenCredential(token), new Date(T0.getTime() - 1))).toBe(
			true
		);
		expect(await credentialValid(db, apiTokenCredential(token), T0)).toBe(false);
	});

	it('keeps a token without an expiry working indefinitely', async () => {
		const { id, token } = await createApiToken(db, admin, admin.id, 'forever');
		const farFuture = new Date('2100-01-01T00:00:00Z');

		expect(
			(await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1))[0]!.expiresAt
		).toBeNull();
		expect((await verifyApiToken(db, token, farFuture))?.id).toBe(admin.id);
		expect(await credentialValid(db, apiTokenCredential(token), farFuture)).toBe(true);
	});

	it('does not stamp last use for a refused token', async () => {
		const { id, token } = await createApiToken(db, admin, admin.id, 'short');
		await expireAt(id, T0);

		await verifyApiToken(db, token, T0);

		expect(
			(await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1))[0]!.lastUsedAt
		).toBeNull();
	});

	it('lists the expiry and whether a token belongs to an OAuth connection', async () => {
		const { id } = await createApiToken(db, admin, admin.id, 'short');
		await expireAt(id, T0);

		const [info] = await listApiTokens(db, admin, admin.id);

		expect(info.expiresAt).toEqual(T0);
		expect(info.oauth).toBe(false);
	});
});

describe('verifyApiToken via', () => {
	it('carries the token that authenticated, so writes can name it', async () => {
		const db = await testDb();
		const user = await seedHuman(db, 'ada');
		const { id, token } = await createApiToken(db, user, user.id, 'norm-mint-main');

		expect((await verifyApiToken(db, token))?.via).toEqual({ tokenId: id, name: 'norm-mint-main' });
	});
});
