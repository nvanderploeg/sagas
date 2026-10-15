import { fail, redirect, type Actions } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { field } from '#lib/server/auth/form.ts';
import { setSessionCookie } from '#lib/server/auth/request.ts';
import { createSession } from '#lib/server/auth/sessions.ts';
import { acceptInvite, isInviteOpen } from '#lib/server/auth/invites.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => ({
	open: isInviteOpen(getDb(), params.token ?? '')
});

export const actions: Actions = {
	default: async ({ params, request, cookies, url }) => {
		const form = await request.formData();
		const username = field(form, 'username');
		const displayName = field(form, 'displayName');
		const db = getDb();
		try {
			const user = await acceptInvite(db, params.token ?? '', {
				username,
				displayName,
				password: field(form, 'password')
			});
			const session = createSession(db, user.id);
			setSessionCookie(cookies, url, session.token, session.expiresAt);
		} catch (error) {
			if (error instanceof DomainError) {
				return fail(error.code === 'not_found' ? 404 : 400, {
					error: error.message,
					username,
					displayName
				});
			}
			throw error;
		}
		redirect(303, '/');
	}
};
