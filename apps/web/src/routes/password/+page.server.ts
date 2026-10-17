import { fail, redirect, type Actions } from '@sveltejs/kit';
import { field } from '#lib/server/auth/form.ts';
import { changePassword } from '#lib/server/auth/users.ts';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { returnPath } from '#lib/ui/return-path.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	return { required: locals.user.mustChangePassword };
};

export const actions: Actions = {
	default: async ({ request, locals, url }) => {
		const { user, credential } = locals;
		if (!user || credential?.kind !== 'session') redirect(303, '/login');
		const form = await request.formData();
		const next = field(form, 'next');
		if (next !== field(form, 'confirm')) {
			return fail(400, { error: 'The new passwords do not match' });
		}
		try {
			await changePassword(getDb(), user, {
				current: field(form, 'current'),
				next,
				keepSessionId: credential.hash
			});
		} catch (error) {
			if (error instanceof DomainError) return fail(400, { error: error.message });
			throw error;
		}
		redirect(303, returnPath(url.searchParams.get('next')));
	}
};
