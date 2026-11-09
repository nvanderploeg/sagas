import { and, eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { realmKeys, realmMembers, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { normalizeRealmKey } from '#lib/server/domain/keys.ts';
import { write } from '#lib/server/domain/write.ts';
import { requireAdmin, type AuthUser } from './users.ts';

// Makes the User an active Owner of the Realm, promoting an existing Membership or Offer. The
// Admin needs no Membership and gains no access. Records no Event, like every Membership change.
export async function assignRealmOwner(
	db: Db,
	actor: AuthUser,
	input: { realmKey: string; user: string }
): Promise<{ realmId: number; userId: number }> {
	requireAdmin(actor);
	const key = normalizeRealmKey(input.realmKey);
	const ref = input.user.trim().toLowerCase();
	if (ref === '') throw new DomainError('invalid', 'Name a User by username or email');
	return write(db, actor, async (tx) => {
		const holder = (await tx.select().from(realmKeys).where(eq(realmKeys.key, key)).limit(1))[0];
		if (!holder) throw new DomainError('not_found', `No Realm has the key ${key}`);
		const column = ref.includes('@') ? users.email : users.username;
		const target = (await tx.select().from(users).where(eq(column, ref)).limit(1))[0];
		if (!target) throw new DomainError('not_found', `No User ${input.user.trim()}`);
		const { realmId } = holder;
		const existing = (
			await tx
				.select()
				.from(realmMembers)
				.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, target.id)))
				.limit(1)
		)[0];
		if (existing === undefined) {
			await tx.insert(realmMembers).values({
				realmId,
				userId: target.id,
				role: 'owner',
				status: 'active',
				invitedBy: actor.id,
				acceptedAt: new Date()
			});
		} else {
			await tx
				.update(realmMembers)
				.set({
					role: 'owner',
					status: 'active',
					acceptedAt: existing.acceptedAt ?? new Date()
				})
				.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, target.id)));
		}
		return { value: { realmId, userId: target.id }, events: [] };
	});
}
