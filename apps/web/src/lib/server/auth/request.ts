import type { Cookies } from '@sveltejs/kit';
import type { Db } from '#lib/server/db/client.ts';
import { resolveSession } from './sessions.ts';
import { verifyApiToken } from './tokens.ts';
import type { AuthUser } from './users.ts';

export const SESSION_COOKIE = 'workload_session';

// A Bearer header decides alone: a malformed or revoked token never falls back to the cookie.
// Any other scheme, such as a reverse proxy's Basic, leaves the decision to the cookie.
export function userFromRequest(
	db: Db,
	request: Request,
	sessionToken: string | undefined
): AuthUser | null {
	const header = request.headers.get('authorization')?.trim() ?? '';
	if (/^Bearer(\s|$)/i.test(header)) {
		const match = /^Bearer\s+(\S+)$/i.exec(header);
		return match ? verifyApiToken(db, match[1]) : null;
	}
	return sessionToken ? resolveSession(db, sessionToken) : null;
}

export function setSessionCookie(cookies: Cookies, url: URL, token: string, expires: Date): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		expires
	});
}

export function clearSessionCookie(cookies: Cookies, url: URL): void {
	cookies.delete(SESSION_COOKIE, { path: '/', secure: url.protocol === 'https:' });
}
