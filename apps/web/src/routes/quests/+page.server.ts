import { redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { createQuest } from '#lib/server/domain/quests.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { perform, signedIn, text } from '#lib/server/ui/form.ts';
import { readQuestList, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const viewer = signedIn(locals);
	const { seq, value } = readAtSeq(getDb(), (tx) => readQuestList(tx, viewer));
	return { seq, list: toJson(value) };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const result = perform('create', () => {
			const quest = createQuest(getDb(), actor, {
				name: text(form, 'name'),
				description: text(form, 'description'),
				ownerId: actor.id
			});
			return { id: quest.id };
		});
		if ('id' in result) redirect(303, `/quests/${result.id}`);
		return result;
	}
};
