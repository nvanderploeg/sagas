import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { sessions, users } from '#lib/server/db/schema.ts';
import { announceRevoked } from './credentials.ts';
import { generateSecret, hashSecret, SESSION_PREFIX } from './secrets.ts';
import { toAuthUser, type AuthUser } from './users.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(
	db: Db,
	userId: number,
	now: Date = new Date()
): Promise<{ token: string; expiresAt: Date }> {
	const token = generateSecret(SESSION_PREFIX);
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	await db.insert(sessions).values({ id: hashSecret(token), userId, expiresAt });
	return { token, expiresAt };
}

export async function resolveSession(
	db: Db,
	token: string,
	now: Date = new Date()
): Promise<AuthUser | null> {
	const id = hashSecret(token);
	const row = (
		await db
			.select({ session: sessions, user: users })
			.from(sessions)
			.innerJoin(users, eq(users.id, sessions.userId))
			.where(eq(sessions.id, id))
			.limit(1)
	)[0];
	if (!row) return null;
	if (row.session.expiresAt.getTime() <= now.getTime()) {
		await endSession(db, id);
		return null;
	}
	return row.user.bannedAt ? null : toAuthUser(row.user);
}

export async function deleteSession(db: Db, token: string): Promise<void> {
	await endSession(db, hashSecret(token));
}

async function endSession(db: Db, id: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, id));
	announceRevoked({ kind: 'session', hash: id });
}
