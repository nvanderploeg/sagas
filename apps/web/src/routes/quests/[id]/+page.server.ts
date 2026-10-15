import { error, isActionFailure, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	addQuestTicket,
	addQuestTicketWithChildren,
	deleteQuest,
	rankQuestTicket,
	removeQuestTicket,
	updateQuest,
	type QuestPatch
} from '#lib/server/domain/quests.ts';
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
			const add = checked(form, 'children') ? addQuestTicketWithChildren : addQuestTicket;
			add(getDb(), actor, questId(params.id), int(form, 'ticketId'));
		});
	},

	remove: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('members', () => {
			removeQuestTicket(getDb(), actor, questId(params.id), int(form, 'ticketId'));
		});
	},

	rank: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('members', () => {
			rankQuestTicket(getDb(), actor, questId(params.id), int(form, 'ticketId'), placement(form));
		});
	},

	delete: async ({ locals, params }) => {
		const actor = signedIn(locals);
		const result = perform('delete', () => deleteQuest(getDb(), actor, questId(params.id)));
		if (!isActionFailure(result)) redirect(303, '/quests');
		return result;
	}
};
