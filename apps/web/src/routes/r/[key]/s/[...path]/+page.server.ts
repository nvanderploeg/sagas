import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { resolveScrollPath } from '#lib/server/domain/scrolls.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { signedIn } from '#lib/server/ui/form.ts';
import { findRealmByKey, toJson } from '#lib/server/ui/reads.ts';
import { scrollActions } from '#lib/server/ui/scroll-actions.ts';
import { readMissingScroll, readScrollPage } from '#lib/server/ui/scroll-reads.ts';
import { normalizePath } from '#lib/ui/scroll-path.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals, url }) => {
	const viewer = signedIn(locals);
	const db = getDb();
	const realm = findRealmByKey(db, params.key, viewer);
	if (!realm) error(404, 'No Realm has that key');
	const path = normalizePath(params.path);
	if (path === null) redirect(307, `/r/${realm.key}/s`);

	const found = resolveScrollPath(db, realm.id, path);
	const canonical = found?.scroll.path ?? path;
	if (realm.key !== params.key || canonical !== params.path) {
		redirect(found && !found.current ? 308 : 307, `/r/${realm.key}/s/${canonical}${url.search}`);
	}
	if (found === null) {
		return {
			seq: null,
			page: null,
			missing: toJson(readMissingScroll(db, viewer, realm.id, path))
		};
	}
	const { seq, value } = readAtSeq(db, (tx) => readScrollPage(tx, viewer, found.scroll.id));
	return { seq, page: toJson(value), missing: null };
};

export const actions: Actions = scrollActions;
