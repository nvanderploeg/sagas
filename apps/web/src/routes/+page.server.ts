import { redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { createRealmWithStates } from '#lib/server/domain/realms.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { perform, signedIn, text } from '#lib/server/ui/form.ts';
import { readHome, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	const viewer = locals.user;
	const { seq, value } = readAtSeq(getDb(), (tx) => readHome(tx, viewer));
	return { seq, home: toJson(value) };
};

export const actions: Actions = {
	createRealm: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const result = perform('createRealm', () => {
			const realm = createRealmWithStates(getDb(), actor, {
				name: text(form, 'name'),
				key: text(form, 'key'),
				initialState: { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' },
				states: [{ key: 'doing', label: 'In progress', color: '#eab308', icon: 'half' }]
			});
			return { key: realm.key };
		});
		if ('key' in result) redirect(303, `/r/${result.key}`);
		return result;
	}
};
