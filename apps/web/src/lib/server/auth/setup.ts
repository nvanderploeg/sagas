import type { Db } from '#lib/server/db/client.ts';
import { insertApiToken } from './tokens.ts';
import { firstAdminValues, insertFirstAdmin, type AuthUser } from './users.ts';

const SETUP_TOKEN_NAME = 'Setup';

export async function completeSetup(
	db: Db,
	input: { username: string; displayName: string; password: string }
): Promise<{ admin: AuthUser; token: string }> {
	const values = await firstAdminValues(db, input);
	return db.transaction((tx) => {
		const admin = insertFirstAdmin(tx, values);
		return { admin, token: insertApiToken(tx, admin.id, SETUP_TOKEN_NAME).token };
	});
}
