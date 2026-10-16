import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { gate, unauthorizedResponse } from '#lib/server/auth/access.ts';
import { authFromRequest, SESSION_COOKIE } from '#lib/server/auth/request.ts';
import { hasUsers, seedAdmin } from '#lib/server/auth/users.ts';
import {
	eventRetentionMs,
	seedAdminPassword,
	seedAdminUsername,
	surveyRetentionMs
} from '#lib/server/config.ts';
import { rebuildDerived } from '#lib/server/agent/derived.ts';
import { scheduleAgentPruning } from '#lib/server/agent/prune.ts';
import { getDb } from '#lib/server/db/index.ts';
import { schedulePruning } from '#lib/server/events/log.ts';

export const init: ServerInit = async () => {
	if (building) return;
	const db = getDb();
	rebuildDerived(db);
	if (seedAdminUsername && seedAdminPassword) {
		await seedAdmin(db, { username: seedAdminUsername, password: seedAdminPassword });
	}
	schedulePruning(db, eventRetentionMs);
	scheduleAgentPruning(db, surveyRetentionMs);
};

export const handle: Handle = async ({ event, resolve }) => {
	const db = getDb();
	const auth = authFromRequest(db, event.request, event.cookies.get(SESSION_COOKIE));
	event.locals.user = auth?.user ?? null;
	event.locals.credential = auth?.credential ?? null;

	const decision = gate(event.url.pathname, {
		setupDone: hasUsers(db),
		signedIn: auth !== null,
		mustChangePassword: auth?.user.mustChangePassword ?? false
	});
	if (decision === 'setup') redirect(303, '/setup');
	if (decision === 'login') redirect(303, '/login');
	if (decision === 'password') redirect(303, '/password');
	if (decision === 'unauthorized') return unauthorizedResponse();
	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
	if (event.url.protocol === 'https:') {
		response.headers.set('strict-transport-security', 'max-age=31536000');
	}
	return response;
};
