import { eq } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { transact } from '#lib/server/db/tx.ts';

export type AuthUser = {
	id: number;
	kind: 'human' | 'agent';
	isAdmin: boolean;
	username: string;
	displayName: string;
	email: string | null;
	realmLimit: number;
	// The API token this User acts through; absent for a session.
	via?: { tokenId: number; name: string };
};

type UserRow = typeof users.$inferSelect;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME = /^[a-z][a-z0-9_-]{1,31}$/;

export function toAuthUser(row: UserRow): AuthUser {
	return {
		id: row.id,
		kind: row.kind,
		isAdmin: row.isAdmin,
		username: row.username,
		displayName: row.displayName,
		email: row.email,
		realmLimit: row.realmLimit
	};
}

export function normalizeUsername(input: string): string {
	const username = input.trim().toLowerCase();
	if (!USERNAME.test(username)) {
		throw new DomainError(
			'invalid',
			'Username must be 2 to 32 characters: a letter first, then letters, digits, - or _'
		);
	}
	return username;
}

export function requireAdmin(actor: AuthUser): void {
	if (!actor.isAdmin) throw new DomainError('forbidden', 'Only an Admin can do that');
}

export async function assertUsernameFree(db: Handle, username: string): Promise<void> {
	if (
		(await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1))[0]
	) {
		throw new DomainError('conflict', `Username ${username} is taken`);
	}
}

export async function createAgentUser(
	db: Db,
	actor: AuthUser,
	input: { username: string; displayName: string }
): Promise<AuthUser> {
	requireAdmin(actor);
	const username = normalizeUsername(input.username);
	const displayName = requireText(input.displayName, 'Display name', 100);

	return transact(db, async (tx) => {
		await assertUsernameFree(tx, username);
		const row = (
			await tx.insert(users).values({ kind: 'agent', username, displayName }).returning()
		)[0];
		return toAuthUser(row);
	});
}

export async function listUsers(db: Handle): Promise<AuthUser[]> {
	return (await db.select().from(users).orderBy(users.displayName, users.id)).map(toAuthUser);
}

export async function findUserByName(db: Handle, username: string): Promise<AuthUser | null> {
	const row = (
		await db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).limit(1)
	)[0];
	return row ? toAuthUser(row) : null;
}

export async function findUser(db: Handle, id: number): Promise<AuthUser | null> {
	const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
	return row ? toAuthUser(row) : null;
}

export async function findUserByFirebaseUid(db: Handle, uid: string): Promise<AuthUser | null> {
	const row = (await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1))[0];
	return row ? toAuthUser(row) : null;
}

export async function setRealmLimit(
	db: Db,
	actor: AuthUser,
	userId: number,
	limit: number
): Promise<AuthUser> {
	requireAdmin(actor);
	if (!Number.isInteger(limit) || limit < 0) {
		throw new DomainError('invalid', 'Realm limit must be a whole number, 0 or more');
	}
	const row = (
		await db.update(users).set({ realmLimit: limit }).where(eq(users.id, userId)).returning()
	)[0];
	if (!row) throw new DomainError('not_found', 'No such User');
	return toAuthUser(row);
}

// Sets the verified email a first Firebase sign-in links to; empty clears it.
export async function setUserEmail(
	db: Db,
	actor: AuthUser,
	userId: number,
	input: string
): Promise<AuthUser> {
	requireAdmin(actor);
	const email = input.trim().toLowerCase();
	if (email !== '' && !EMAIL.test(email)) throw new DomainError('invalid', 'Not an email address');
	return transact(db, async (tx) => {
		if (email !== '') {
			const taken = (
				await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
			)[0];
			if (taken && taken.id !== userId) {
				throw new DomainError('conflict', `Email ${email} belongs to another User`);
			}
		}
		const row = (
			await tx
				.update(users)
				.set({ email: email === '' ? null : email })
				.where(eq(users.id, userId))
				.returning()
		)[0];
		if (!row) throw new DomainError('not_found', 'No such User');
		return toAuthUser(row);
	});
}

// Clears the Firebase sign-in a User is linked to; their email stays, so the next verified
// sign-in with it links again.
export async function unlinkSignIn(db: Db, actor: AuthUser, userId: number): Promise<AuthUser> {
	requireAdmin(actor);
	const row = (
		await db.update(users).set({ firebaseUid: null }).where(eq(users.id, userId)).returning()
	)[0];
	if (!row) throw new DomainError('not_found', 'No such User');
	return toAuthUser(row);
}
