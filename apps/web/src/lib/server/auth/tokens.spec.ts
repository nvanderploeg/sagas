import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { apiTokens } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createAgentUser, createFirstAdmin, findUser, type AuthUser } from './users.ts';
import { createApiToken, revokeApiToken, verifyApiToken } from './tokens.ts';
import { hashSecret } from './secrets.ts';
import { seedHuman } from './fixtures.ts';

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

function expectCode(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

describe('API token storage', () => {
	it('stores only the sha256 of the token', () => {
		const { id, token } = createApiToken(db, admin, admin.id, 'laptop');

		const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()!;

		expect(token.startsWith('wlt_')).toBe(true);
		expect(row.tokenHash).toBe(hashSecret(token));
		expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(row)).not.toContain(token);
	});

	it('gives every token a fresh secret', () => {
		const first = createApiToken(db, admin, admin.id, 'a').token;
		const second = createApiToken(db, admin, admin.id, 'b').token;

		expect(first).not.toBe(second);
	});
});

describe('API token verification', () => {
	it('resolves the token to the User it was created for and stamps last use', () => {
		const { id, token } = createApiToken(db, admin, admin.id, 'laptop');

		expect(verifyApiToken(db, token)?.id).toBe(admin.id);
		const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()!;
		expect(row.lastUsedAt).toBeInstanceOf(Date);
	});

	it('rejects an unknown or altered token', () => {
		const { token } = createApiToken(db, admin, admin.id, 'laptop');

		expect(verifyApiToken(db, 'wlt_unknown')).toBeNull();
		expect(verifyApiToken(db, token + 'x')).toBeNull();
	});

	it('rejects a revoked token, and revoking twice is harmless', () => {
		const { id, token } = createApiToken(db, admin, admin.id, 'laptop');

		revokeApiToken(db, admin, id);
		revokeApiToken(db, admin, id);

		expect(verifyApiToken(db, token)).toBeNull();
	});
});

describe('who may manage a token', () => {
	it('lets an Admin create and revoke tokens for an Agent user', () => {
		const bot = createAgentUser(db, admin, { username: 'mcp-bot', displayName: 'MCP' });

		const { id, token } = createApiToken(db, admin, bot.id, 'mcp');

		expect(verifyApiToken(db, token)?.id).toBe(bot.id);
		revokeApiToken(db, admin, id);
		expect(verifyApiToken(db, token)).toBeNull();
	});

	it('lets a User create a token only for itself', () => {
		const grace = seedHuman(db, 'grace');

		expect(createApiToken(db, grace, grace.id, 'own').token).toMatch(/^wlt_/);
		expectCode(() => createApiToken(db, grace, admin.id, 'theirs'), 'forbidden');
	});

	it('stops an Admin creating a token that acts as another human', () => {
		const grace = seedHuman(db, 'grace');

		expectCode(() => createApiToken(db, admin, grace.id, 'impersonate'), 'forbidden');
	});

	it('stops a User revoking another User token', () => {
		const grace = seedHuman(db, 'grace');
		const { id } = createApiToken(db, admin, admin.id, 'root');

		expectCode(() => revokeApiToken(db, grace, id), 'forbidden');
	});

	it('reports an unknown User as not found when creating a token', () => {
		expectCode(() => createApiToken(db, admin, 999, 'ghost'), 'not_found');
	});

	it('rejects a blank token name', () => {
		expectCode(() => createApiToken(db, admin, admin.id, '  '), 'invalid');
	});

	it('exposes the User behind a token through findUser', () => {
		expect(findUser(db, admin.id)?.username).toBe('root');
	});
});
