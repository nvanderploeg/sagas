import type { Db } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { toAuthUser, type AuthUser } from './users.ts';

export async function seedHuman(db: Db, username: string): Promise<AuthUser> {
	const row = (
		await db
			.insert(users)
			.values({ kind: 'human', username, displayName: username, passwordHash: 'hash' })
			.returning()
	)[0];
	return toAuthUser(row);
}
