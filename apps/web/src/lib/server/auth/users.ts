import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { apiTokens, users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { announceRevoked } from './credentials.ts';
import { sessionVerifier } from './firebase.ts';
import { transact } from '#lib/server/db/tx.ts';

export type AuthUser = {
	id: number;
	kind: 'human' | 'agent';
	isAdmin: boolean;
	username: string;
	displayName: string;
	email: string | null;
	realmLimit: number;
	banned: boolean;
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
		realmLimit: row.realmLimit,
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
		await db
			.update(users)
			.set({ realmLimit: limit })
			.where(and(eq(users.id, userId), eq(users.kind, 'human')))
			.returning()
	)[0];
	if (!row) {
		const target = (
			await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId))
		)[0];
		if (target?.kind === 'agent') {
			throw new DomainError(
				'invalid',
				'Agent users cannot create Realms, so they have no Realm limit'
			);
		}
		throw new DomainError('not_found', 'No such User');
	}
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
// sign-in, but the Firebase sessions and tokens it ended stay ended.
export async function setBanned(
	db: Db,
	actor: AuthUser,
	input: { userId: number; banned: boolean; confirm: string }
): Promise<void> {
	const target = await targetOf(db, actor, input.userId, input.confirm);
	const tokens = await transact(db, async (tx) => {
		await tx
			.update(users)
			.set({ bannedAt: input.banned ? new Date() : null })
			.where(eq(users.id, target.id));
		if (!input.banned) return [];
		return await tx
			.update(apiTokens)
			.set({ revokedAt: new Date() })
			.where(and(eq(apiTokens.userId, target.id), isNull(apiTokens.revokedAt)))
			.returning({ hash: apiTokens.tokenHash });
	});
	for (const { hash } of tokens) announceRevoked({ kind: 'api_token', hash });
	if (input.banned && target.firebaseUid) {
		await sessionVerifier.revoke(target.firebaseUid).catch(() => undefined);
	}
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
// Rows that belong to the User alone (tokens, memberships) cascade away.
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
		const gone = await tx
			.select({ hash: apiTokens.tokenHash })
			.from(apiTokens)
			.where(eq(apiTokens.userId, target.id));
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
	for (const { hash } of ended) announceRevoked({ kind: 'api_token', hash });
	if (target.firebaseUid) await sessionVerifier.revoke(target.firebaseUid).catch(() => undefined);
}
