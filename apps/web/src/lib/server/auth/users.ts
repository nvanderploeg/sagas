import { and, count, eq, ne } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { sessions, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { announceRevoked } from './credentials.ts';
import { checkPassword, hashPassword, spendPasswordTime, verifyPassword } from './password.ts';
import { transact } from '#lib/server/db/tx.ts';

export type AuthUser = {
	id: number;
	kind: 'human' | 'agent';
	isAdmin: boolean;
	username: string;
	displayName: string;
	mustChangePassword: boolean;
	// The API token this User acts through; absent for a session.
	via?: { tokenId: number; name: string };
};

type UserRow = typeof users.$inferSelect;

const USERNAME = /^[a-z][a-z0-9_-]{1,31}$/;

export function toAuthUser(row: UserRow): AuthUser {
	return {
		id: row.id,
		kind: row.kind,
		isAdmin: row.isAdmin,
		username: row.username,
		displayName: row.displayName,
		mustChangePassword: row.mustChangePassword
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

export async function hasUsers(db: Handle): Promise<boolean> {
	return ((await db.select({ n: count() }).from(users).limit(1))[0]?.n ?? 0) > 0;
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

type SetupInput = { username: string; displayName: string; password: string };

type NewUser = typeof users.$inferInsert;

export async function firstAdminValues(db: Handle, input: SetupInput): Promise<NewUser> {
	if (await hasUsers(db)) throw new DomainError('conflict', 'Setup is already complete');
	const username = normalizeUsername(input.username);
	const displayName = requireText(input.displayName, 'Display name', 100);
	const passwordHash = await hashPassword(input.password);
	return { kind: 'human', isAdmin: true, username, displayName, passwordHash };
}

// Call inside the transaction that creates the Admin, so two concurrent setups cannot both win.
export async function insertFirstAdmin(tx: Handle, values: NewUser): Promise<AuthUser> {
	if (await hasUsers(tx)) throw new DomainError('conflict', 'Setup is already complete');
	return toAuthUser((await tx.insert(users).values(values).returning())[0]);
}

export async function createFirstAdmin(db: Db, input: SetupInput): Promise<AuthUser> {
	const values = await firstAdminValues(db, input);
	return transact(db, (tx) => insertFirstAdmin(tx, values));
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
	const row = (await db.select().from(users).where(eq(users.username, normalized)).limit(1))[0];
	if (!row || row.passwordHash === null) {
		await spendPasswordTime(password);
		return null;
	}
	return (await verifyPassword(row.passwordHash, password)) ? toAuthUser(row) : null;
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

// Creates the Admin an operator configured when no User has that username. The password is a
// placeholder: the Admin must change it before doing anything else.
export async function seedAdmin(
	db: Db,
	input: { username: string; password: string }
): Promise<AuthUser | null> {
	const username = normalizeUsername(input.username);
	if (await findUserByName(db, username)) return null;
	const passwordHash = await hashPassword(input.password);
	return transact(db, async (tx) => {
		if (await findUserByName(tx, username)) return null;
		const row = (
			await tx
				.insert(users)
				.values({
					kind: 'human',
					isAdmin: true,
					username,
					displayName: username,
					passwordHash,
					mustChangePassword: true
				})
				.onConflictDoNothing()
				.returning()
		)[0];
		return row ? toAuthUser(row) : null;
	});
}

// Ends every session but `keepSessionId`'s, so a stolen session does not outlive the change.
export async function changePassword(
	db: Db,
	user: AuthUser,
	input: { current: string; next: string; keepSessionId: string }
): Promise<void> {
	const row = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
	if (!row?.passwordHash || !(await verifyPassword(row.passwordHash, input.current))) {
		throw new DomainError('invalid', 'Current password is wrong');
	}
	if (input.next === input.current) {
		throw new DomainError('invalid', 'New password must differ from the current one');
	}
	const passwordHash = await hashPassword(checkPassword(input.next));
	const ended = await transact(db, async (tx) => {
		await tx
			.update(users)
			.set({ passwordHash, mustChangePassword: false })
			.where(eq(users.id, user.id));
		return await tx
			.delete(sessions)
			.where(and(eq(sessions.userId, user.id), ne(sessions.id, input.keepSessionId)))
			.returning({ id: sessions.id });
	});
	for (const { id } of ended) announceRevoked({ kind: 'session', hash: id });
}
