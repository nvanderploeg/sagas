import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { readBoard } from '#lib/server/domain/realms.ts';
import { createLabour, rankLabour, readLabour, updateLabour } from '#lib/server/domain/labours.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { int, perform, placement, signedIn, text } from '#lib/server/ui/form.ts';
import { findRealmByKey, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

function realmFor(key: string) {
	const realm = findRealmByKey(getDb(), key);
	if (!realm) error(404, 'No Realm has that key');
	return realm;
}

export const load: PageServerLoad = ({ params }) => {
	const realm = realmFor(params.key);
	if (realm.key !== params.key) redirect(307, `/r/${realm.key}`);
	try {
		const { seq, value } = readAtSeq(getDb(), (tx) => readBoard(tx, realm.id));
		return { seq, board: toJson(value) };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No Realm has that key');
		throw e;
	}
};

export const actions: Actions = {
	create: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(params.key);
		return perform('create', () => {
			const labour = createLabour(getDb(), actor, {
				realmId: realm.id,
				title: text(form, 'title'),
				ownerId: actor.id,
				stateId: int(form, 'stateId'),
				placement: 'bottom'
			});
			return { id: labour.id, key: labour.key };
		});
	},

	// A new State moves the Labour there; the same State only ranks it.
	move: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const db = getDb();
		return perform('move', () => {
			const id = int(form, 'labourId');
			const stateId = int(form, 'stateId');
			const where = placement(form);
			if (readLabour(db, id).stateId === stateId) rankLabour(db, actor, id, where);
			else updateLabour(db, actor, id, { stateId, placement: where });
		});
	}
};
