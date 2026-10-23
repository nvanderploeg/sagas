import { and, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { labours, realmMembers } from '../db/schema.ts';
import { DomainError } from './errors.ts';

export type Role = 'owner' | 'editor' | 'viewer';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

let enforced = true;

// Only the test setup turns this off; the server always enforces.
export function setAccessEnforced(on: boolean): void {
	enforced = on;
}

export function accessEnforced(): boolean {
	return enforced;
}

export const atLeast = (role: Role, needed: Role): boolean => RANK[role] >= RANK[needed];

// An Offer grants nothing, so only an active Membership has a role.
export function memberRole(db: Handle, realmId: number, userId: number): Role | null {
	return (
		db
			.select({ role: realmMembers.role })
			.from(realmMembers)
			.where(
				and(
					eq(realmMembers.realmId, realmId),
					eq(realmMembers.userId, userId),
					eq(realmMembers.status, 'active')
				)
			)
			.get()?.role ?? null
	);
}

// A Realm the User cannot see is not found, never forbidden: its existence stays private.
export function requireRealmRole(
	db: Handle,
	user: { id: number },
	realmId: number,
	needed: Role
): void {
	if (!enforced) return;
	const role = memberRole(db, realmId, user.id);
	if (role === null) throw new DomainError('not_found', 'Realm not found');
	if (!atLeast(role, needed)) {
		throw new DomainError('forbidden', `This needs ${needed} access to the Realm`);
	}
}

export function canSeeRealm(db: Handle, user: { id: number }, realmId: number): boolean {
	return !enforced || memberRole(db, realmId, user.id) !== null;
}

// The Realms the User is an active member of; null when access is not enforced, meaning all.
export function visibleRealmIds(db: Handle, user: { id: number }): number[] | null {
	if (!enforced) return null;
	return db
		.select({ id: realmMembers.realmId })
		.from(realmMembers)
		.where(and(eq(realmMembers.userId, user.id), eq(realmMembers.status, 'active')))
		.all()
		.map((row) => row.id);
}

// Owner and Assignee of a Labour are members of its Realm.
export function requireActiveMember(
	db: Handle,
	realmId: number,
	userId: number,
	field: string
): void {
	if (!enforced) return;
	if (memberRole(db, realmId, userId) === null) {
		throw new DomainError('invalid', `${field} is not a member of the Realm`);
	}
}

export function canSeeLabour(db: Handle, user: { id: number }, labourId: number): boolean {
	if (!enforced) return true;
	const row = db
		.select({ realmId: labours.realmId })
		.from(labours)
		.where(eq(labours.id, labourId))
		.get();
	return row !== undefined && memberRole(db, row.realmId, user.id) !== null;
}
