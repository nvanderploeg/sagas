import { count, eq } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { hashPassword, spendPasswordTime, verifyPassword } from './password.ts';

export type AuthUser = {
	id: number;
	kind: 'human' | 'agent';
	isAdmin: boolean;
	username: string;
	displayName: string;
};

type UserRow = typeof users.$inferSelect;

const USERNAME = /^[a-z][a-z0-9_-]{1,31}$/;

export function toAuthUser(row: UserRow): AuthUser {
	return {
		id: row.id,
		kind: row.kind,
		isAdmin: row.isAdmin,
		username: row.username,
		displayName: row.displayName
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

export function hasUsers(db: Handle): boolean {
	return (db.select({ n: count() }).from(users).get()?.n ?? 0) > 0;
}

export function requireAdmin(actor: AuthUser): void {
	if (!actor.isAdmin) throw new DomainError('forbidden', 'Only an Admin can do that');
}

export function assertUsernameFree(db: Handle, username: string): void {
	if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
		throw new DomainError('conflict', `Username ${username} is taken`);
	}
}

// The lock check runs inside the transaction, so two concurrent setups cannot both create an Admin.
export async function createFirstAdmin(
	db: Db,
	input: { username: string; displayName: string; password: string }
): Promise<AuthUser> {
	if (hasUsers(db)) throw new DomainError('conflict', 'Setup is already complete');
	const username = normalizeUsername(input.username);
	const displayName = requireText(input.displayName, 'Display name', 100);
	const passwordHash = await hashPassword(input.password);

	return db.transaction((tx) => {
		if (hasUsers(tx)) throw new DomainError('conflict', 'Setup is already complete');
		const row = tx
			.insert(users)
			.values({ kind: 'human', isAdmin: true, username, displayName, passwordHash })
			.returning()
			.get();
		return toAuthUser(row);
	});
}

export function createAgentUser(
	db: Db,
	actor: AuthUser,
	input: { username: string; displayName: string }
): AuthUser {
	requireAdmin(actor);
	const username = normalizeUsername(input.username);
	const displayName = requireText(input.displayName, 'Display name', 100);

	return db.transaction((tx) => {
		assertUsernameFree(tx, username);
		const row = tx.insert(users).values({ kind: 'agent', username, displayName }).returning().get();
		return toAuthUser(row);
	});
}

export async function authenticate(
	db: Db,
	username: string,
	password: string
): Promise<AuthUser | null> {
	let normalized: string;
	try {
		normalized = normalizeUsername(username);
	} catch {
		await spendPasswordTime(password);
		return null;
	}
	const row = db.select().from(users).where(eq(users.username, normalized)).get();
	if (!row || row.passwordHash === null) {
		await spendPasswordTime(password);
		return null;
	}
	return (await verifyPassword(row.passwordHash, password)) ? toAuthUser(row) : null;
}

export function findUser(db: Handle, id: number): AuthUser | null {
	const row = db.select().from(users).where(eq(users.id, id)).get();
	return row ? toAuthUser(row) : null;
}
