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
export async function memberRole(
	db: Handle,
	realmId: number,
	userId: number
): Promise<Role | null> {
	return (
		(
			await db
				.select({ role: realmMembers.role })
				.from(realmMembers)
				.where(
					and(
						eq(realmMembers.realmId, realmId),
						eq(realmMembers.userId, userId),
						eq(realmMembers.status, 'active')
					)
				)
				.limit(1)
		)[0]?.role ?? null
	);
}

// A Realm the User cannot see is not found, never forbidden: its existence stays private.
export async function requireRealmRole(
	db: Handle,
	user: { id: number },
	realmId: number,
	needed: Role
): Promise<void> {
	if (!enforced) return;
	const role = await memberRole(db, realmId, user.id);
	if (role === null) throw new DomainError('not_found', 'Realm not found');
	if (!atLeast(role, needed)) {
		throw new DomainError('forbidden', `This needs ${needed} access to the Realm`);
	}
}

export async function canSeeRealm(
	db: Handle,
	user: { id: number },
	realmId: number
): Promise<boolean> {
	return !enforced || (await memberRole(db, realmId, user.id)) !== null;
}

// The Realms the User is an active member of; null when access is not enforced, meaning all.
export async function visibleRealmIds(db: Handle, user: { id: number }): Promise<number[] | null> {
	if (!enforced) return null;
	return (
		await db
			.select({ id: realmMembers.realmId })
			.from(realmMembers)
			.where(and(eq(realmMembers.userId, user.id), eq(realmMembers.status, 'active')))
	).map((row) => row.id);
}

// Owner and Assignee of a Labour are members of its Realm.
export async function requireActiveMember(
	db: Handle,
	realmId: number,
	userId: number,
	field: string
): Promise<void> {
	if (!enforced) return;
	if ((await memberRole(db, realmId, userId)) === null) {
		throw new DomainError('invalid', `${field} is not a member of the Realm`);
	}
}

export async function canSeeLabour(
	db: Handle,
	user: { id: number },
	labourId: number
): Promise<boolean> {
	if (!enforced) return true;
	const row = (
		await db
			.select({ realmId: labours.realmId })
			.from(labours)
			.where(eq(labours.id, labourId))
			.limit(1)
	)[0];
	return row !== undefined && (await memberRole(db, row.realmId, user.id)) !== null;
}
