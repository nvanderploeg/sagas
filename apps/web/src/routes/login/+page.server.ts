import { redirect } from '@sveltejs/kit';
import { firebaseWebConfig } from '#lib/server/config.ts';
import { returnPath } from '#lib/ui/return-path.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, returnPath(url.searchParams.get('next')));
	return { firebase: firebaseWebConfig };
};
