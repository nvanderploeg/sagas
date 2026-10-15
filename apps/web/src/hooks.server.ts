import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { gate, unauthorizedResponse } from '#lib/server/auth/access.ts';
import { authFromRequest, SESSION_COOKIE } from '#lib/server/auth/request.ts';
import { hasUsers } from '#lib/server/auth/users.ts';
import { eventRetentionMs } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import { schedulePruning } from '#lib/server/events/log.ts';

export const init: ServerInit = () => {
	if (building) return;
	schedulePruning(getDb(), eventRetentionMs);
};

export const handle: Handle = async ({ event, resolve }) => {
	const db = getDb();
	const auth = authFromRequest(db, event.request, event.cookies.get(SESSION_COOKIE));
	event.locals.user = auth?.user ?? null;
	event.locals.credential = auth?.credential ?? null;

	const decision = gate(event.url.pathname, { setupDone: hasUsers(db), signedIn: auth !== null });
	if (decision === 'setup') redirect(303, '/setup');
	if (decision === 'login') redirect(303, '/login');
	if (decision === 'unauthorized') return unauthorizedResponse();
	return resolve(event);
};
