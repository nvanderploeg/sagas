import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { invites, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { hashPassword } from './password.ts';
import { generateSecret, hashSecret, INVITE_PREFIX } from './secrets.ts';
import {
	assertUsernameFree,
	normalizeUsername,
	requireAdmin,
	toAuthUser,
	type AuthUser
} from './users.ts';
import { transact } from '#lib/server/db/tx.ts';

export async function createInvite(
	db: Db,
	actor: AuthUser
): Promise<{ id: number; token: string }> {
	requireAdmin(actor);
	const token = generateSecret(INVITE_PREFIX);
	const row = (
		await db
			.insert(invites)
			.values({ tokenHash: hashSecret(token), createdByUserId: actor.id })
			.returning({ id: invites.id })
	)[0];
	return { id: row.id, token };
}

export type InviteInfo = {
	id: number;
	createdByUserId: number;
	createdAt: Date;
	usedAt: Date | null;
	usedByUserId: number | null;
};

export async function listInvites(db: Db, actor: AuthUser): Promise<InviteInfo[]> {
	requireAdmin(actor);
	return await db
		.select({
			id: invites.id,
			createdByUserId: invites.createdByUserId,
			createdAt: invites.createdAt,
			usedAt: invites.usedAt,
			usedByUserId: invites.usedByUserId
		})
		.from(invites)
		.orderBy(invites.id);
}

export async function isInviteOpen(db: Db, token: string): Promise<boolean> {
	return (
		(
			await db
				.select({ id: invites.id })
				.from(invites)
				.where(and(eq(invites.tokenHash, hashSecret(token)), isNull(invites.usedAt)))
				.limit(1)
		)[0] !== undefined
	);
}

// The open check and the consumption share a transaction, so an invite is accepted once.
export async function acceptInvite(
	db: Db,
	token: string,
	input: { username: string; displayName: string; password: string }
): Promise<AuthUser> {
	const username = normalizeUsername(input.username);
	const displayName = requireText(input.displayName, 'Display name', 100);
	const passwordHash = await hashPassword(input.password);

	return transact(db, async (tx) => {
		const invite = (
			await tx
				.select({ id: invites.id })
				.from(invites)
				.where(and(eq(invites.tokenHash, hashSecret(token)), isNull(invites.usedAt)))
				.limit(1)
		)[0];
		if (!invite) {
			throw new DomainError('not_found', 'This invite is invalid or has already been used');
		}
		await assertUsernameFree(tx, username);
		const user = (
			await tx
				.insert(users)
				.values({ kind: 'human', username, displayName, passwordHash })
				.returning()
		)[0];
		await tx
			.update(invites)
			.set({ usedAt: new Date(), usedByUserId: user.id })
			.where(eq(invites.id, invite.id));
		return toAuthUser(user);
	});
}
