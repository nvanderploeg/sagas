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

export function createInvite(db: Db, actor: AuthUser): { id: number; token: string } {
	requireAdmin(actor);
	const token = generateSecret(INVITE_PREFIX);
	const row = db
		.insert(invites)
		.values({ tokenHash: hashSecret(token), createdByUserId: actor.id })
		.returning({ id: invites.id })
		.get();
	return { id: row.id, token };
}

export function isInviteOpen(db: Db, token: string): boolean {
	return (
		db
			.select({ id: invites.id })
			.from(invites)
			.where(and(eq(invites.tokenHash, hashSecret(token)), isNull(invites.usedAt)))
			.get() !== undefined
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

	return db.transaction((tx) => {
		const invite = tx
			.select({ id: invites.id })
			.from(invites)
			.where(and(eq(invites.tokenHash, hashSecret(token)), isNull(invites.usedAt)))
			.get();
		if (!invite) {
			throw new DomainError('not_found', 'This invite is invalid or has already been used');
		}
		assertUsernameFree(tx, username);
		const user = tx
			.insert(users)
			.values({ kind: 'human', username, displayName, passwordHash })
			.returning()
			.get();
		tx.update(invites)
			.set({ usedAt: new Date(), usedByUserId: user.id })
			.where(eq(invites.id, invite.id))
			.run();
		return toAuthUser(user);
	});
}
