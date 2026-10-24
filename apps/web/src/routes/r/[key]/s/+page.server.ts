import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { signedIn } from '#lib/server/ui/form.ts';
import { findRealmByKey, toJson } from '#lib/server/ui/reads.ts';
import { scrollActions } from '#lib/server/ui/scroll-actions.ts';
import { readScrollIndex } from '#lib/server/ui/scroll-reads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals, url }) => {
	const viewer = signedIn(locals);
	const db = getDb();
	const realm = findRealmByKey(db, params.key, viewer);
	if (!realm) error(404, 'No Realm has that key');
	if (realm.key !== params.key) redirect(307, `/r/${realm.key}/s${url.search}`);
	const query = url.searchParams.get('q') ?? '';
	const { seq, value } = readAtSeq(db, (tx) => readScrollIndex(tx, viewer, realm.id, query));
	return { seq, page: toJson(value) };
};

export const actions: Actions = scrollActions;
