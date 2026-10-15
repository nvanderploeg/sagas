import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { sessions, users } from '#lib/server/db/schema.ts';
import { generateSecret, hashSecret, SESSION_PREFIX } from './secrets.ts';
import { toAuthUser, type AuthUser } from './users.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(
	db: Db,
	userId: number,
	now: Date = new Date()
): { token: string; expiresAt: Date } {
	const token = generateSecret(SESSION_PREFIX);
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	db.insert(sessions)
		.values({ id: hashSecret(token), userId, expiresAt })
		.run();
	return { token, expiresAt };
}

export function resolveSession(db: Db, token: string, now: Date = new Date()): AuthUser | null {
	const id = hashSecret(token);
	const row = db
		.select({ session: sessions, user: users })
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.id, id))
		.get();
	if (!row) return null;
	if (row.session.expiresAt.getTime() <= now.getTime()) {
		db.delete(sessions).where(eq(sessions.id, id)).run();
		return null;
	}
	return toAuthUser(row.user);
}

export function deleteSession(db: Db, token: string): void {
	db.delete(sessions)
		.where(eq(sessions.id, hashSecret(token)))
		.run();
}
