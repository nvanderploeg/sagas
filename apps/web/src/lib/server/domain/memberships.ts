import { mapSeq } from '#lib/server/async.ts';
import { and, asc, count, eq, inArray, ne, or } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { labours, realmMembers, realms, users } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { memberRole, requireRealmRole, type Role } from './access.ts';
import { DomainError } from './errors.ts';
import { readLabour } from './labours.ts';
import { getRealm, getUser } from './lookup.ts';
import { write, type Actor } from './write.ts';

export type Member = {
	userId: number;
	username: string;
	displayName: string;
	kind: 'human' | 'agent';
	role: Role;
	status: 'pending' | 'active';
	invitedBy: number | null;
	createdAt: Date;
	acceptedAt: Date | null;
};

export type Offer = {
	realmId: number;
	realmKey: string;
	realmName: string;
	role: Role;
	invitedBy: number | null;
	createdAt: Date;
};

const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];

export function requireRole(role: string): Role {
	if (!ROLES.includes(role as Role)) {
		throw new DomainError('invalid', `A role is one of ${ROLES.join(', ')}`);
	}
	return role as Role;
}

// Members, and for an Owner the pending Offers too.
export async function listMembers(
	db: Handle,
	viewer: { id: number },
	realmId: number
): Promise<Member[]> {
	await requireRealmRole(db, viewer, realmId, 'viewer');
	const isOwner = (await memberRole(db, realmId, viewer.id)) === 'owner';
	return (
		await db
			.select({
				userId: users.id,
				username: users.username,
				displayName: users.displayName,
				kind: users.kind,
				role: realmMembers.role,
				status: realmMembers.status,
				invitedBy: realmMembers.invitedBy,
				createdAt: realmMembers.createdAt,
				acceptedAt: realmMembers.acceptedAt
			})
			.from(realmMembers)
			.innerJoin(users, eq(users.id, realmMembers.userId))
			.where(eq(realmMembers.realmId, realmId))
			.orderBy(asc(realmMembers.createdAt), asc(users.id))
	).filter((member) => isOwner || member.status === 'active');
}

export async function listOffers(db: Handle, userId: number): Promise<Offer[]> {
	return await db
		.select({
			realmId: realms.id,
			realmKey: realms.key,
			realmName: realms.name,
			role: realmMembers.role,
			invitedBy: realmMembers.invitedBy,
			createdAt: realmMembers.createdAt
		})
		.from(realmMembers)
		.innerJoin(realms, eq(realms.id, realmMembers.realmId))
		.where(and(eq(realmMembers.userId, userId), eq(realmMembers.status, 'pending')))
		.orderBy(asc(realmMembers.createdAt));
}

export async function addOwner(tx: Handle, realmId: number, userId: number): Promise<void> {
	await tx.insert(realmMembers).values({
		realmId,
		userId,
		role: 'owner',
		status: 'active',
		acceptedAt: new Date()
	});
}

// An existing Membership or Offer is left as it is: a role changes through setMemberRole.
export async function offerMembership(
	db: Db,
	actor: Actor,
	realmId: number,
	userId: number,
	role: Role
): Promise<Member> {
	return write(db, actor, async (tx) => {
		await requireRealmRole(tx, actor, realmId, 'owner');
		await getRealm(tx, realmId);
		await getUser(tx, userId);
		const existing = (
			await tx
				.select()
				.from(realmMembers)
				.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
				.limit(1)
		)[0];
		if (existing === undefined) {
			await tx
				.insert(realmMembers)
				.values({ realmId, userId, role, status: 'pending', invitedBy: actor.id });
		}
		return { value: await readMember(tx, realmId, userId), events: [] };
	});
}

// Withdrawing an Offer and declining it are the same deletion.
export async function declineOffer(db: Db, actor: Actor, realmId: number): Promise<void> {
	await write(db, actor, async (tx) => {
		const deleted = await tx
			.delete(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, actor.id),
					eq(realmMembers.status, 'pending')
				)
			);
		if ((deleted.rowCount ?? 0) === 0) throw new DomainError('not_found', 'Offer not found');
		return { value: undefined, events: [] };
	});
}

export async function acceptOffer(db: Db, actor: Actor, realmId: number): Promise<Member> {
	return write(db, actor, async (tx) => {
		const accepted = await tx
			.update(realmMembers)
			.set({ status: 'active', acceptedAt: new Date() })
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, actor.id),
					eq(realmMembers.status, 'pending')
				)
			);
		if ((accepted.rowCount ?? 0) === 0) throw new DomainError('not_found', 'Offer not found');
		return { value: await readMember(tx, realmId, actor.id), events: [] };
	});
}

export async function withdrawOffer(
	db: Db,
	actor: Actor,
	realmId: number,
	userId: number
): Promise<void> {
	await write(db, actor, async (tx) => {
		await requireRealmRole(tx, actor, realmId, 'owner');
		const deleted = await tx
			.delete(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, userId),
					eq(realmMembers.status, 'pending')
				)
			);
		if ((deleted.rowCount ?? 0) === 0) throw new DomainError('not_found', 'Offer not found');
		return { value: undefined, events: [] };
	});
}

export async function setMemberRole(
	db: Db,
	actor: Actor,
	realmId: number,
	userId: number,
	role: Role
): Promise<Member> {
	return write(db, actor, async (tx) => {
		await requireRealmRole(tx, actor, realmId, 'owner');
		const current = await memberRole(tx, realmId, userId);
		if (current === null) throw new DomainError('not_found', 'Member not found');
		if (current === 'owner' && role !== 'owner') await requireAnotherOwner(tx, realmId, userId);
		await tx
			.update(realmMembers)
			.set({ role })
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)));
		return { value: await readMember(tx, realmId, userId), events: [] };
	});
}

// An Owner removes anyone; a member removes themselves. Their Assignee clears on the Realm's
// Labours and their Owner passes to the Realm's earliest remaining Owner.
export async function removeMember(
	db: Db,
	actor: Actor,
	realmId: number,
	userId: number
): Promise<void> {
	await write(db, actor, async (tx) => {
		if (userId !== actor.id) await requireRealmRole(tx, actor, realmId, 'owner');
		const role = await memberRole(tx, realmId, userId);
		if (role === null) throw new DomainError('not_found', 'Member not found');
		if (role === 'owner') await requireAnotherOwner(tx, realmId, userId);
		const successor = await earliestOwner(tx, realmId, userId);
		const touched = await tx
			.select({ id: labours.id, ownerId: labours.ownerId, assigneeId: labours.assigneeId })
			.from(labours)
			.where(
				and(
					eq(labours.realmId, realmId),
					or(eq(labours.ownerId, userId), eq(labours.assigneeId, userId))
				)
			);
		const now = new Date();
		for (const row of touched) {
			await tx
				.update(labours)
				.set({
					ownerId: row.ownerId === userId ? successor : row.ownerId,
					assigneeId: row.assigneeId === userId ? null : row.assigneeId,
					updatedAt: now
				})
				.where(eq(labours.id, row.id));
		}
		await tx
			.delete(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)));
		const events = await mapSeq(touched, async (row): Promise<EventSpec> => ({
			type: 'labour.updated',
			data: { labour: await readLabour(tx, row.id) }
		}));
		return { value: undefined, events };
	});
}

async function earliestOwner(tx: Handle, realmId: number, except: number): Promise<number> {
	const row = (
		await tx
			.select({ userId: realmMembers.userId })
			.from(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.role, 'owner'),
					eq(realmMembers.status, 'active'),
					ne(realmMembers.userId, except)
				)
			)
			.orderBy(asc(realmMembers.acceptedAt), asc(realmMembers.userId))
			.limit(1)
	)[0];
	if (row === undefined) throw new DomainError('conflict', 'A Realm needs another Owner first');
	return row.userId;
}

async function requireAnotherOwner(tx: Handle, realmId: number, userId: number): Promise<void> {
	const others = (
		await tx
			.select({ n: count() })
			.from(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.role, 'owner'),
					eq(realmMembers.status, 'active'),
					ne(realmMembers.userId, userId)
				)
			)
			.limit(1)
	)[0]!.n;
	if (others === 0) {
		throw new DomainError('conflict', 'The last Owner cannot leave or be demoted');
	}
}

async function readMember(tx: Handle, realmId: number, userId: number): Promise<Member> {
	const row = (
		await tx
			.select({
				userId: users.id,
				username: users.username,
				displayName: users.displayName,
				kind: users.kind,
				role: realmMembers.role,
				status: realmMembers.status,
				invitedBy: realmMembers.invitedBy,
				createdAt: realmMembers.createdAt,
				acceptedAt: realmMembers.acceptedAt
			})
			.from(realmMembers)
			.innerJoin(users, eq(users.id, realmMembers.userId))
			.where(and(eq(realmMembers.realmId, realmId), inArray(realmMembers.userId, [userId])))
			.limit(1)
	)[0];
	if (row === undefined) throw new DomainError('not_found', 'Member not found');
	return row;
}
