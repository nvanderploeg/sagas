import { listUsers } from '#lib/server/auth/users.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { LayoutServerLoad } from './$types';

// Users record no Events: the directory is as fresh as the last load.
export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.user) return { user: null, people: [] };
	const people = listUsers(getDb()).map(({ id, kind, username, displayName }) => ({
		id,
		kind,
		username,
		displayName
	}));
	return { user: locals.user, people };
};
