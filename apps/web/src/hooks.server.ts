import { json, redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { gate } from '#lib/server/auth/access.ts';
import { SESSION_COOKIE, userFromRequest } from '#lib/server/auth/request.ts';
import { hasUsers } from '#lib/server/auth/users.ts';
import { getDb } from '#lib/server/db/index.ts';

export const init: ServerInit = () => {
	if (building) return;
	getDb();
};

export const handle: Handle = async ({ event, resolve }) => {
	const db = getDb();
	const user = userFromRequest(db, event.request, event.cookies.get(SESSION_COOKIE));
	event.locals.user = user;

	const decision = gate(event.url.pathname, { setupDone: hasUsers(db), signedIn: user !== null });
	if (decision === 'setup') redirect(303, '/setup');
	if (decision === 'login') redirect(303, '/login');
	if (decision === 'unauthorized') {
		return json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'www-authenticate': 'Bearer' } }
		);
	}
	return resolve(event);
};
