import type { Cookies } from '@sveltejs/kit';
import type { Db } from '#lib/server/db/client.ts';
import {
	announceRevoked,
	apiTokenCredential,
	sessionCredential,
	type Credential
} from './credentials.ts';
import { sessionVerifier } from './firebase.ts';
import { verifyApiToken } from './tokens.ts';
import { adminEmails, authCookieDomain } from '#lib/server/config.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { signInIdentity } from './signin.ts';
import { findUserByFirebaseUid, type AuthUser } from './users.ts';

export type Auth = { user: AuthUser; credential: Credential };

// Shared by every runestone app: signing in to one signs in to all.
export const SESSION_COOKIE = 'runestone_session';

// A Bearer header decides alone: a malformed or revoked token never falls back to the cookie.
// Any other scheme, such as a reverse proxy's Basic, leaves the decision to the cookie.
export async function authFromRequest(
	db: Db,
	request: Request,
	sessionToken: string | undefined
): Promise<Auth | null> {
	const header = request.headers.get('authorization')?.trim() ?? '';
	if (/^Bearer(\s|$)/i.test(header)) {
		const match = /^Bearer\s+(\S+)$/i.exec(header);
		if (!match) return null;
		const user = await verifyApiToken(db, match[1]);
		return user && { user, credential: apiTokenCredential(match[1]) };
	}
	if (!sessionToken) return null;
	const identity = await sessionVerifier.verify(sessionToken);
	if (!identity) return null;
	let user = await findUserByFirebaseUid(db, identity.uid);
	if (!user) {
		try {
			user = await signInIdentity(db, identity, adminEmails);
		} catch (error) {
			if (error instanceof DomainError) return null;
			throw error;
		}
	}
	return user && { user, credential: sessionCredential(sessionToken) };
}

export function setSessionCookie(cookies: Cookies, url: URL, token: string, expires: Date): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		...(authCookieDomain ? { domain: authCookieDomain } : {}),
		expires
	});
}

export function clearSessionCookie(cookies: Cookies, url: URL): void {
	cookies.delete(SESSION_COOKIE, {
		path: '/',
		secure: url.protocol === 'https:',
		...(authCookieDomain ? { domain: authCookieDomain } : {})
	});
}

async function revokeBehind(token: string): Promise<void> {
	const { kind, hash } = sessionCredential(token);
	announceRevoked({ kind, hash });
	const identity = await sessionVerifier.verify(token);
	if (identity) await sessionVerifier.revoke(identity.uid);
}

// Revokes the User's Firebase sessions everywhere, then clears the cookie whatever happens.
export async function endSession(cookies: Cookies, url: URL): Promise<void> {
	const token = cookies.get(SESSION_COOKIE);
	if (token) await revokeBehind(token).catch(() => undefined);
	clearSessionCookie(cookies, url);
}
