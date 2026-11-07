import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { setSessionVerifier, type FirebaseIdentity } from './firebase.ts';
import { toAuthUser, type AuthUser } from './users.ts';

// Specs build many Realms per User; the limit has its own specs.
const ROOMY = 1000;

export async function seedHuman(db: Db, username: string): Promise<AuthUser> {
	const row = (
		await db
			.insert(users)
			.values({ kind: 'human', username, displayName: username, realmLimit: ROOMY })
			.returning()
	)[0];
	return toAuthUser(row);
}

export async function seedAdmin(
	db: Db,
	username = 'root',
	displayName = 'Root'
): Promise<AuthUser> {
	const row = (
		await db
			.insert(users)
			.values({ kind: 'human', isAdmin: true, username, displayName, realmLimit: ROOMY })
			.returning()
	)[0];
	return toAuthUser(row);
}

// Stands in for Firebase: a session cookie is live until `end` is called on it.
export function fakeSessions() {
	const live = new Map<string, FirebaseIdentity>();
	setSessionVerifier({
		exchange: () => Promise.resolve(null),
		verify: (cookie) => Promise.resolve(live.get(cookie) ?? null)
	});
	return {
		async open(db: Db, user: AuthUser): Promise<string> {
			const uid = `uid-${user.id}`;
			await db.update(users).set({ firebaseUid: uid }).where(eq(users.id, user.id));
			const cookie = `cookie-${randomUUID()}`;
			live.set(cookie, { uid, email: user.email, emailVerified: true, name: null });
			return cookie;
		},
		openIdentity(identity: FirebaseIdentity): string {
			const cookie = `cookie-${randomUUID()}`;
			live.set(cookie, identity);
			return cookie;
		},
		end(cookie: string): void {
			live.delete(cookie);
		},
		restore(): void {
			setSessionVerifier(null);
		}
	};
}
