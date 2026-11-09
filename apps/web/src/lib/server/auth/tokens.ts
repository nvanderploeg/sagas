import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { apiTokens, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { announceRevoked } from './credentials.ts';
import { revokeGrantRows } from './oauth.ts';
import { API_TOKEN_PREFIX, generateSecret, hashSecret } from './secrets.ts';
import { toAuthUser, type AuthUser } from './users.ts';
import { transact } from '#lib/server/db/tx.ts';

// A User manages its own tokens; an Admin manages the tokens of Agent users only.
function assertCanManageTokens(actor: AuthUser, target: { id: number; kind: 'human' | 'agent' }) {
	if (actor.id === target.id) return;
	if (actor.isAdmin && target.kind === 'agent') return;
	throw new DomainError(
		'forbidden',
		'Only the owner, or an Admin for an Agent user, can manage its tokens'
	);
}

async function requireUserRow(db: Handle, id: number) {
	const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
	if (!row) throw new DomainError('not_found', 'User not found');
	return row;
}

export async function createApiToken(
	db: Db,
	actor: AuthUser,
	userId: number,
	name: string
): Promise<{ id: number; token: string }> {
	return transact(db, async (tx) => {
		assertCanManageTokens(actor, await requireUserRow(tx, userId));
		return insertApiToken(tx, userId, name);
	});
}

export async function insertApiToken(
	db: Handle,
	userId: number,
	name: string
): Promise<{ id: number; token: string }> {
	const token = generateSecret(API_TOKEN_PREFIX);
	const row = (
		await db
			.insert(apiTokens)
			.values({ userId, name: requireText(name, 'Token name', 100), tokenHash: hashSecret(token) })
			.returning({ id: apiTokens.id })
	)[0];
	return { id: row.id, token };
}

export type ApiTokenInfo = {
	id: number;
	name: string;
	createdAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
	expiresAt: Date | null;
	oauth: boolean;
};

export async function listApiTokens(
	db: Handle,
	actor: AuthUser,
	userId: number
): Promise<ApiTokenInfo[]> {
	assertCanManageTokens(actor, await requireUserRow(db, userId));
	return (
		await db
			.select({
				id: apiTokens.id,
				name: apiTokens.name,
				createdAt: apiTokens.createdAt,
				lastUsedAt: apiTokens.lastUsedAt,
				revokedAt: apiTokens.revokedAt,
				expiresAt: apiTokens.expiresAt,
				grantId: apiTokens.grantId
			})
			.from(apiTokens)
			.where(eq(apiTokens.userId, userId))
			.orderBy(apiTokens.id)
	).map(({ grantId, ...token }) => ({ ...token, oauth: grantId !== null }));
}

export async function revokeApiToken(db: Db, actor: AuthUser, tokenId: number): Promise<void> {
	const revoked = await transact(db, async (tx) => {
		const token = (await tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1))[0];
		if (!token) throw new DomainError('not_found', 'API token not found');
		assertCanManageTokens(actor, await requireUserRow(tx, token.userId));
		if (token.grantId !== null) return revokeGrantRows(tx, token.grantId, new Date());
		if (token.revokedAt !== null) return null;
		await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
		return token.tokenHash;
	});
	if (revoked !== null) announceRevoked({ kind: 'api_token', hash: revoked });
}

export async function verifyApiToken(
	db: Db,
	token: string,
	now = new Date()
): Promise<AuthUser | null> {
	const row = (
		await db
			.select({ token: apiTokens, user: users })
			.from(apiTokens)
			.innerJoin(users, eq(users.id, apiTokens.userId))
			.where(
				and(
					eq(apiTokens.tokenHash, hashSecret(token)),
					isNull(apiTokens.revokedAt),
					or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))
				)
			)
			.limit(1)
	)[0];
	if (!row || row.user.bannedAt) return null;
	await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id));
	return { ...toAuthUser(row.user), via: { tokenId: row.token.id, name: row.token.name } };
}
