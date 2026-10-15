import { and, eq, isNull } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { apiTokens, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { announceRevoked } from './credentials.ts';
import { API_TOKEN_PREFIX, generateSecret, hashSecret } from './secrets.ts';
import { toAuthUser, type AuthUser } from './users.ts';

// A User manages its own tokens; an Admin manages the tokens of Agent users only.
function assertCanManageTokens(actor: AuthUser, target: { id: number; kind: 'human' | 'agent' }) {
	if (actor.id === target.id) return;
	if (actor.isAdmin && target.kind === 'agent') return;
	throw new DomainError(
		'forbidden',
		'Only the owner, or an Admin for an Agent user, can manage its tokens'
	);
}

function requireUserRow(db: Handle, id: number) {
	const row = db.select().from(users).where(eq(users.id, id)).get();
	if (!row) throw new DomainError('not_found', 'User not found');
	return row;
}

export function createApiToken(
	db: Db,
	actor: AuthUser,
	userId: number,
	name: string
): { id: number; token: string } {
	return db.transaction((tx) => {
		assertCanManageTokens(actor, requireUserRow(tx, userId));
		return insertApiToken(tx, userId, name);
	});
}

export function insertApiToken(
	db: Handle,
	userId: number,
	name: string
): { id: number; token: string } {
	const token = generateSecret(API_TOKEN_PREFIX);
	const row = db
		.insert(apiTokens)
		.values({ userId, name: requireText(name, 'Token name', 100), tokenHash: hashSecret(token) })
		.returning({ id: apiTokens.id })
		.get();
	return { id: row.id, token };
}

export function revokeApiToken(db: Db, actor: AuthUser, tokenId: number): void {
	const revoked = db.transaction((tx) => {
		const token = tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
		if (!token) throw new DomainError('not_found', 'API token not found');
		assertCanManageTokens(actor, requireUserRow(tx, token.userId));
		if (token.revokedAt !== null) return null;
		tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId)).run();
		return token.tokenHash;
	});
	if (revoked !== null) announceRevoked({ kind: 'api_token', hash: revoked });
}

export function verifyApiToken(db: Db, token: string): AuthUser | null {
	const row = db
		.select({ token: apiTokens, user: users })
		.from(apiTokens)
		.innerJoin(users, eq(users.id, apiTokens.userId))
		.where(and(eq(apiTokens.tokenHash, hashSecret(token)), isNull(apiTokens.revokedAt)))
		.get();
	if (!row) return null;
	db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id)).run();
	return toAuthUser(row.user);
}
