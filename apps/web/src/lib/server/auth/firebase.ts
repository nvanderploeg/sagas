import { readFileSync } from 'node:fs';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { firebaseProjectId } from '../config.ts';

export type FirebaseIdentity = {
	uid: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
};

export type SessionVerifier = {
	// Trades a freshly issued ID token for a session cookie and the identity it carries.
	exchange(
		idToken: string,
		ttlMs: number
	): Promise<{ cookie: string; identity: FirebaseIdentity } | null>;
	// Null for a cookie that is invalid, expired or revoked.
	verify(cookie: string): Promise<FirebaseIdentity | null>;
};

const FRESH_SIGN_IN_MS = 5 * 60 * 1000;

function serviceAccount(): object | null {
	const json = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
	if (json) return JSON.parse(json) as object;
	const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE?.trim();
	return file ? (JSON.parse(readFileSync(file, 'utf8')) as object) : null;
}

function app(): App {
	const existing = getApps()[0];
	if (existing) return existing;
	const account = serviceAccount();
	if (account === null && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
		throw new Error('Set FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT');
	}
	return initializeApp({
		projectId: firebaseProjectId,
		...(account === null ? {} : { credential: cert(account as Parameters<typeof cert>[0]) })
	});
}

function identityOf(claims: {
	uid: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
}): FirebaseIdentity {
	return {
		uid: claims.uid,
		email: claims.email?.toLowerCase() ?? null,
		emailVerified: claims.email_verified === true,
		name: claims.name ?? null
	};
}

const adminVerifier: SessionVerifier = {
	async exchange(idToken, ttlMs) {
		const auth = getAuth(app());
		const claims = await auth.verifyIdToken(idToken, true);
		if (Date.now() - claims.auth_time * 1000 > FRESH_SIGN_IN_MS) return null;
		const cookie = await auth.createSessionCookie(idToken, { expiresIn: ttlMs });
		return { cookie, identity: identityOf(claims) };
	},
	async verify(cookie) {
		try {
			return identityOf(await getAuth(app()).verifySessionCookie(cookie, true));
		} catch {
			return null;
		}
	}
};

let current: SessionVerifier = adminVerifier;

export const sessionVerifier: SessionVerifier = {
	exchange: (idToken, ttlMs) => current.exchange(idToken, ttlMs),
	verify: (cookie) => current.verify(cookie)
};

export function setSessionVerifier(verifier: SessionVerifier | null): void {
	current = verifier ?? adminVerifier;
}
