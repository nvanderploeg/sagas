import { redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { createProjectWithStates } from '#lib/server/domain/projects.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { perform, signedIn, text } from '#lib/server/ui/form.ts';
import { readHome, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	const userId = locals.user.id;
	const { seq, value } = readAtSeq(getDb(), (tx) => readHome(tx, userId));
	return { seq, home: toJson(value) };
};

export const actions: Actions = {
	createProject: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const result = perform('createProject', () => {
			const project = createProjectWithStates(getDb(), actor, {
				name: text(form, 'name'),
				key: text(form, 'key'),
				initialState: { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' },
				states: [{ key: 'doing', label: 'In progress', color: '#eab308', icon: 'half' }]
			});
			return { key: project.key };
		});
		if ('key' in result) redirect(303, `/p/${result.key}`);
		return result;
	}
};
