import { fail, redirect, type Actions } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { setSessionCookie } from '#lib/server/auth/request.ts';
import { createSession } from '#lib/server/auth/sessions.ts';
import { completeSetup } from '#lib/server/auth/setup.ts';
import { hasUsers } from '#lib/server/auth/users.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { field } from '#lib/server/auth/form.ts';
import type { PageServerLoad } from './$types';

// Redirect GETs only: the action's response renders this page, with the new token, after the
// Admin exists.
export const load: PageServerLoad = ({ locals, request }) => {
	if (request.method === 'GET' && hasUsers(getDb())) redirect(303, locals.user ? '/' : '/login');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const username = field(form, 'username');
		const displayName = field(form, 'displayName');
		const db = getDb();
		try {
			const { admin, token } = await completeSetup(db, {
				username,
				displayName,
				password: field(form, 'password')
			});
			const session = createSession(db, admin.id);
			setSessionCookie(cookies, url, session.token, session.expiresAt);
			return { token };
		} catch (error) {
			if (error instanceof DomainError) {
				return fail(error.code === 'conflict' ? 409 : 400, {
					error: error.message,
					username,
					displayName
				});
			}
			throw error;
		}
	}
};
