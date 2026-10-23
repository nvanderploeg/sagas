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
export function listMembers(db: Handle, viewer: { id: number }, realmId: number): Member[] {
	requireRealmRole(db, viewer, realmId, 'viewer');
	const isOwner = memberRole(db, realmId, viewer.id) === 'owner';
	return db
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
		.all()
		.filter((member) => isOwner || member.status === 'active');
}

export function listOffers(db: Handle, userId: number): Offer[] {
	return db
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
		.orderBy(asc(realmMembers.createdAt))
		.all();
}

export function addOwner(tx: Handle, realmId: number, userId: number): void {
	tx.insert(realmMembers)
		.values({
			realmId,
			userId,
			role: 'owner',
			status: 'active',
			acceptedAt: new Date()
		})
		.run();
}

// An existing Membership or Offer is left as it is: a role changes through setMemberRole.
export function offerMembership(
	db: Db,
	actor: Actor,
	realmId: number,
	userId: number,
	role: Role
): Member {
	return write(db, actor, (tx) => {
		requireRealmRole(tx, actor, realmId, 'owner');
		getRealm(tx, realmId);
		getUser(tx, userId);
		const existing = tx
			.select()
			.from(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
			.get();
		if (existing === undefined) {
			tx.insert(realmMembers)
				.values({ realmId, userId, role, status: 'pending', invitedBy: actor.id })
				.run();
		}
		return { value: readMember(tx, realmId, userId), events: [] };
	});
}

// Withdrawing an Offer and declining it are the same deletion.
export function declineOffer(db: Db, actor: Actor, realmId: number): void {
	write(db, actor, (tx) => {
		const deleted = tx
			.delete(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, actor.id),
					eq(realmMembers.status, 'pending')
				)
			)
			.run();
		if (deleted.changes === 0) throw new DomainError('not_found', 'Offer not found');
		return { value: undefined, events: [] };
	});
}

export function acceptOffer(db: Db, actor: Actor, realmId: number): Member {
	return write(db, actor, (tx) => {
		const accepted = tx
			.update(realmMembers)
			.set({ status: 'active', acceptedAt: new Date() })
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, actor.id),
					eq(realmMembers.status, 'pending')
				)
			)
			.run();
		if (accepted.changes === 0) throw new DomainError('not_found', 'Offer not found');
		return { value: readMember(tx, realmId, actor.id), events: [] };
	});
}

export function withdrawOffer(db: Db, actor: Actor, realmId: number, userId: number): void {
	write(db, actor, (tx) => {
		requireRealmRole(tx, actor, realmId, 'owner');
		const deleted = tx
			.delete(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, userId),
					eq(realmMembers.status, 'pending')
				)
			)
			.run();
		if (deleted.changes === 0) throw new DomainError('not_found', 'Offer not found');
		return { value: undefined, events: [] };
	});
}

export function setMemberRole(
	db: Db,
	actor: Actor,
	realmId: number,
	userId: number,
	role: Role
): Member {
	return write(db, actor, (tx) => {
		requireRealmRole(tx, actor, realmId, 'owner');
		const current = memberRole(tx, realmId, userId);
		if (current === null) throw new DomainError('not_found', 'Member not found');
		if (current === 'owner' && role !== 'owner') requireAnotherOwner(tx, realmId, userId);
		tx.update(realmMembers)
			.set({ role })
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
			.run();
		return { value: readMember(tx, realmId, userId), events: [] };
	});
}

// An Owner removes anyone; a member removes themselves. Their Assignee clears on the Realm's
// Labours and their Owner passes to the Realm's earliest remaining Owner.
export function removeMember(db: Db, actor: Actor, realmId: number, userId: number): void {
	write(db, actor, (tx) => {
		if (userId !== actor.id) requireRealmRole(tx, actor, realmId, 'owner');
		const role = memberRole(tx, realmId, userId);
		if (role === null) throw new DomainError('not_found', 'Member not found');
		if (role === 'owner') requireAnotherOwner(tx, realmId, userId);
		const successor = earliestOwner(tx, realmId, userId);
		const touched = tx
			.select({ id: labours.id, ownerId: labours.ownerId, assigneeId: labours.assigneeId })
			.from(labours)
			.where(
				and(
					eq(labours.realmId, realmId),
					or(eq(labours.ownerId, userId), eq(labours.assigneeId, userId))
				)
			)
			.all();
		const now = new Date();
		for (const row of touched) {
			tx.update(labours)
				.set({
					ownerId: row.ownerId === userId ? successor : row.ownerId,
					assigneeId: row.assigneeId === userId ? null : row.assigneeId,
					updatedAt: now
				})
				.where(eq(labours.id, row.id))
				.run();
		}
		tx.delete(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
			.run();
		const events = touched.map((row): EventSpec => ({
			type: 'labour.updated',
			data: { labour: readLabour(tx, row.id) }
		}));
		return { value: undefined, events };
	});
}

function earliestOwner(tx: Handle, realmId: number, except: number): number {
	const row = tx
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
		.get();
	if (row === undefined) throw new DomainError('conflict', 'A Realm needs another Owner first');
	return row.userId;
}

function requireAnotherOwner(tx: Handle, realmId: number, userId: number): void {
	const others = tx
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
		.get()!.n;
	if (others === 0) {
		throw new DomainError('conflict', 'The last Owner cannot leave or be demoted');
	}
}

function readMember(tx: Handle, realmId: number, userId: number): Member {
	const row = tx
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
		.get();
	if (row === undefined) throw new DomainError('not_found', 'Member not found');
	return row;
}
