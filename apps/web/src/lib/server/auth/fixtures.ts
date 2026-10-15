import type { Db } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { toAuthUser, type AuthUser } from './users.ts';

export function seedHuman(db: Db, username: string): AuthUser {
	const row = db
		.insert(users)
		.values({ kind: 'human', username, displayName: username, passwordHash: 'hash' })
		.returning()
		.get();
	return toAuthUser(row);
}
