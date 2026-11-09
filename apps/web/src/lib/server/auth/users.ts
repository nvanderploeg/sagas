import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { apiTokens, sessions, users } from '#lib/server/db/schema.ts';
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
	banned: boolean;
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
		mustChangePassword: row.mustChangePassword,
		banned: row.bannedAt !== null
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
	if (!(await verifyPassword(row.passwordHash, password))) return null;
	return row.bannedAt ? null : toAuthUser(row);
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

// Sets a one-time password the User must change at next sign-in, and ends all their sessions.
export async function resetPassword(
	db: Db,
	actor: AuthUser,
	userId: number
): Promise<{ password: string }> {
	requireAdmin(actor);
	if (userId === actor.id) {
		throw new DomainError('invalid', 'Change your own password from your account page');
	}
	const target = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
	if (!target) throw new DomainError('not_found', 'User not found');
	if (target.kind !== 'human') throw new DomainError('invalid', 'Agent users have no password');
	const password = randomBytes(12).toString('base64url');
	const passwordHash = await hashPassword(password);
	const ended = await transact(db, async (tx) => {
		await tx
			.update(users)
			.set({ passwordHash, mustChangePassword: true })
			.where(eq(users.id, userId));
		return await tx
			.delete(sessions)
			.where(eq(sessions.userId, userId))
			.returning({ id: sessions.id });
	});
	for (const { id } of ended) announceRevoked({ kind: 'session', hash: id });
	return { password };
}

async function targetOf(db: Handle, actor: AuthUser, userId: number, confirm: string) {
	requireAdmin(actor);
	if (userId === actor.id) throw new DomainError('invalid', 'You cannot do that to yourself');
	const target = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
	if (!target) throw new DomainError('not_found', 'User not found');
	if (confirm.trim().toLowerCase() !== target.username) {
		throw new DomainError('invalid', `Type ${target.username} to confirm`);
	}
	return target;
}

// A banned User cannot sign in or use a token; their history stays. Lifting the ban restores
// sign-in, but the sessions and tokens it ended stay ended.
export async function setBanned(
	db: Db,
	actor: AuthUser,
	input: { userId: number; banned: boolean; confirm: string }
): Promise<void> {
	const target = await targetOf(db, actor, input.userId, input.confirm);
	const ended = await transact(db, async (tx) => {
		await tx
			.update(users)
			.set({ bannedAt: input.banned ? new Date() : null })
			.where(eq(users.id, target.id));
		if (!input.banned) return { sessions: [], tokens: [] };
		return {
			sessions: await tx
				.delete(sessions)
				.where(eq(sessions.userId, target.id))
				.returning({ id: sessions.id }),
			tokens: await tx
				.update(apiTokens)
				.set({ revokedAt: new Date() })
				.where(and(eq(apiTokens.userId, target.id), isNull(apiTokens.revokedAt)))
				.returning({ hash: apiTokens.tokenHash })
		};
	});
	for (const { id } of ended.sessions) announceRevoked({ kind: 'session', hash: id });
	for (const { hash } of ended.tokens) announceRevoked({ kind: 'api_token', hash });
}

export const DELETED_USERNAME = 'deleted-user';

async function deletedUserId(tx: Handle): Promise<number> {
	const existing = (
		await tx.select({ id: users.id }).from(users).where(eq(users.username, DELETED_USERNAME))
	)[0];
	if (existing) return existing.id;
	return (
		await tx
			.insert(users)
			.values({
				kind: 'agent',
				username: DELETED_USERNAME,
				displayName: 'Deleted user',
				bannedAt: new Date()
			})
			.returning({ id: users.id })
	)[0].id;
}

// Everything the User authored or owned is reassigned to the Deleted user, so history stays whole.
// Rows that belong to the User alone (sessions, tokens, memberships) cascade away.
export async function deleteUser(
	db: Db,
	actor: AuthUser,
	input: { userId: number; confirm: string }
): Promise<void> {
	const target = await targetOf(db, actor, input.userId, input.confirm);
	if (target.username === DELETED_USERNAME) {
		throw new DomainError('invalid', 'The Deleted user stands in for removed Users');
	}
	const ended = await transact(db, async (tx) => {
		const gone = {
			sessions: await tx
				.select({ id: sessions.id })
				.from(sessions)
				.where(eq(sessions.userId, target.id)),
			tokens: await tx
				.select({ hash: apiTokens.tokenHash })
				.from(apiTokens)
				.where(eq(apiTokens.userId, target.id))
		};
		const references = await tx.execute<{ tbl: string; col: string }>(sql`
			SELECT format('%I.%I', n.nspname, c.relname) AS tbl, quote_ident(a.attname) AS col
			FROM pg_constraint k
			JOIN pg_class c ON c.oid = k.conrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
			WHERE k.contype = 'f' AND k.confrelid = 'sagas_users'::regclass AND k.confdeltype = 'a'`);
		const stand = await deletedUserId(tx);
		for (const { tbl, col } of references.rows) {
			await tx.execute(sql.raw(`UPDATE ${tbl} SET ${col} = ${stand} WHERE ${col} = ${target.id}`));
		}
		await tx.delete(users).where(eq(users.id, target.id));
		return gone;
	});
	for (const { id } of ended.sessions) announceRevoked({ kind: 'session', hash: id });
	for (const { hash } of ended.tokens) announceRevoked({ kind: 'api_token', hash });
}
