import { fail, redirect, type Actions } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { field } from '#lib/server/auth/form.ts';
import { setSessionCookie } from '#lib/server/auth/request.ts';
import { clearFailures, isThrottled, recordFailure } from '#lib/server/auth/throttle.ts';
import { createSession } from '#lib/server/auth/sessions.ts';
import { authenticate, hasUsers } from '#lib/server/auth/users.ts';
import { returnPath } from '#lib/ui/return-path.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const db = getDb();
	if (!hasUsers(db)) redirect(303, '/setup');
	if (locals.user) redirect(303, returnPath(url.searchParams.get('next')));
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const username = field(form, 'username');
		const attempts = [`ip:${getClientAddress()}`, `user:${username.trim().toLowerCase()}`];
		if (isThrottled(attempts)) {
			return fail(429, { error: 'Too many attempts. Try again in a few minutes.', username });
		}
		const db = getDb();
		const user = await authenticate(db, username, field(form, 'password'));
		if (!user) {
			recordFailure(attempts);
			return fail(400, { error: 'Wrong username or password', username });
		}
		clearFailures(attempts.slice(1));

		const session = createSession(db, user.id);
		setSessionCookie(cookies, url, session.token, session.expiresAt);
		redirect(303, returnPath(url.searchParams.get('next')));
	}
};
