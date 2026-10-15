import { redirect, type RequestHandler } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { clearSessionCookie, SESSION_COOKIE } from '#lib/server/auth/request.ts';
import { deleteSession } from '#lib/server/auth/sessions.ts';

export const POST: RequestHandler = ({ cookies, url }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) deleteSession(getDb(), token);
	clearSessionCookie(cookies, url);
	redirect(303, '/login');
};
