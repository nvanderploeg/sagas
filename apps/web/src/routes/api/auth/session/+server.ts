import { json, type RequestHandler } from '@sveltejs/kit';
import { sessionVerifier } from '#lib/server/auth/firebase.ts';
import { endSession, setSessionCookie } from '#lib/server/auth/request.ts';
import { signInIdentity } from '#lib/server/auth/signin.ts';
import { adminEmails } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';

const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const body: unknown = await request.json().catch(() => null);
	const idToken =
		typeof body === 'object' && body !== null && 'idToken' in body ? body.idToken : null;
	if (typeof idToken !== 'string' || idToken === '') {
		return json({ error: 'idToken is required' }, { status: 400 });
	}
	let exchanged: Awaited<ReturnType<typeof sessionVerifier.exchange>>;
	try {
		exchanged = await sessionVerifier.exchange(idToken, SESSION_TTL_MS);
	} catch {
		return json({ error: 'Sign-in could not be verified' }, { status: 401 });
	}
	if (!exchanged) return json({ error: 'Sign in again' }, { status: 401 });
	try {
		await signInIdentity(getDb(), exchanged.identity, adminEmails);
	} catch (error) {
		if (error instanceof DomainError) {
			return json({ error: error.message }, { status: error.code === 'conflict' ? 409 : 403 });
		}
		throw error;
	}
	setSessionCookie(cookies, url, exchanged.cookie, new Date(Date.now() + SESSION_TTL_MS));
	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ cookies, url }) => {
	endSession(cookies, url);
	return json({ ok: true });
};
