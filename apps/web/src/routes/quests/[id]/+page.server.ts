import { error, isActionFailure, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	addQuestLabour,
	addQuestLabours,
	deleteQuest,
	rankQuestLabour,
	removeQuestLabour,
	updateQuest,
	type QuestPatch
} from '#lib/server/domain/quests.ts';
import { listChildren } from '#lib/server/domain/labours.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { checked, int, perform, placement, signedIn, text } from '#lib/server/ui/form.ts';
import { readQuestPage, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

function questId(raw: string): number {
	if (!/^\d+$/.test(raw)) error(404, 'No such Quest');
	return Number(raw);
}

export const load: PageServerLoad = ({ params }) => {
	const id = questId(params.id);
	try {
		const { seq, value } = readAtSeq(getDb(), (tx) => readQuestPage(tx, id));
		return { seq, page: toJson(value) };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No such Quest');
		throw e;
	}
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('update', () => {
			const patch: QuestPatch = {};
			if (form.has('name')) patch.name = text(form, 'name');
			if (form.has('description')) patch.description = text(form, 'description');
			if (form.has('ownerId')) patch.ownerId = int(form, 'ownerId');
			updateQuest(getDb(), actor, questId(params.id), patch);
		});
	},

	add: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('add', () => {
			const db = getDb();
			const id = questId(params.id);
			const labourId = int(form, 'labourId');
			if (!checked(form, 'children')) {
				addQuestLabour(db, actor, id, labourId);
				return;
			}
			const children = listChildren(db, labourId).map((child) => child.id);
			const added = addQuestLabours(db, actor, id, [labourId, ...children]);
			if (added.labourIds.length === 0) {
				throw new DomainError('conflict', 'The Labour and its Children are already in the Quest');
			}
		});
	},

	remove: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('members', () => {
			removeQuestLabour(getDb(), actor, questId(params.id), int(form, 'labourId'));
		});
	},

	rank: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('members', () => {
			rankQuestLabour(getDb(), actor, questId(params.id), int(form, 'labourId'), placement(form));
		});
	},

	delete: async ({ locals, params }) => {
		const actor = signedIn(locals);
		const result = perform('delete', () => deleteQuest(getDb(), actor, questId(params.id)));
		if (!isActionFailure(result)) redirect(303, '/quests');
		return result;
	}
};
