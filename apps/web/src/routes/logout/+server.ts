import { redirect, type RequestHandler } from '@sveltejs/kit';
import { announceRevoked, sessionCredential } from '#lib/server/auth/credentials.ts';
import { clearSessionCookie, SESSION_COOKIE } from '#lib/server/auth/request.ts';

export const POST: RequestHandler = ({ cookies, url }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) {
		const { kind, hash } = sessionCredential(token);
		announceRevoked({ kind, hash });
	}
	clearSessionCookie(cookies, url);
	redirect(303, '/login');
};
