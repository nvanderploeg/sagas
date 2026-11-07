import { listUsers } from '#lib/server/auth/users.ts';
import { listOffers } from '#lib/server/domain/memberships.ts';
import { getDb } from '#lib/server/db/index.ts';
import { firebaseWebConfig } from '#lib/server/config.ts';
import { PEOPLE } from '#lib/ui/people.ts';
import type { LayoutServerLoad } from './$types';

// Users record no Events: the directory is as fresh as the last load of PEOPLE.
export const load: LayoutServerLoad = async ({ locals, depends }) => {
	depends(PEOPLE);
	if (!locals.user) return { user: null, people: [], offers: 0, firebase: firebaseWebConfig };
	const people = (await listUsers(getDb())).map(({ id, kind, username, displayName }) => ({
		id,
		kind,
		username,
		displayName
	}));
	return {
		user: locals.user,
		people,
		offers: (await listOffers(getDb(), locals.user.id)).length,
		firebase: firebaseWebConfig
	};
};
