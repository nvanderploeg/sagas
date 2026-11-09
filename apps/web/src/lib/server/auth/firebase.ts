import { createHash } from 'node:crypto';
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
	// Null for a cookie that is invalid, expired or revoked; throws AuthUnavailableError when
	// Firebase cannot be asked.
	verify(cookie: string): Promise<FirebaseIdentity | null>;
	// Signs the uid out everywhere: every session cookie and ID token issued before now stops verifying.
	revoke(uid: string): Promise<void>;
};

export class AuthUnavailableError extends Error {
	constructor(cause: unknown) {
		super('Firebase could not be reached to verify the session', { cause });
		this.name = 'AuthUnavailableError';
	}
}

const TOKEN_INVALID_CODES: ReadonlySet<string> = new Set([
	'auth/id-token-expired',
	'auth/id-token-revoked',
	'auth/session-cookie-expired',
	'auth/session-cookie-revoked',
	'auth/argument-error',
	'auth/invalid-id-token'
]);

// Only these codes mean Firebase refused the token; every other failure is infrastructure.
export function isInvalidSession(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && TOKEN_INVALID_CODES.has(code);
}

export const VERIFY_CACHE_MS = 5000;
const VERIFY_CACHE_MAX = 500;

// Remembers verified identities for a few seconds, keyed by a hash of the cookie. Only successes are
// kept; revoke(uid) drops that uid's entries and bars any verify already in flight from caching.
export function cachedVerify(
	inner: (cookie: string) => Promise<FirebaseIdentity | null>,
	now: () => number = Date.now
) {
	const entries = new Map<string, { identity: FirebaseIdentity; until: number }>();
	let sequence = 0;
	const revokedAt = new Map<string, number>();
	return {
		async verify(cookie: string): Promise<FirebaseIdentity | null> {
			const key = createHash('sha256').update(cookie).digest('hex');
			const hit = entries.get(key);
			if (hit && hit.until > now()) return hit.identity;
			entries.delete(key);
			const started = sequence;
			const identity = await inner(cookie);
			if (identity && (revokedAt.get(identity.uid) ?? 0) <= started) {
				if (entries.size >= VERIFY_CACHE_MAX) {
					for (const [k, v] of entries) if (v.until <= now()) entries.delete(k);
					if (entries.size >= VERIFY_CACHE_MAX) entries.clear();
				}
				entries.set(key, { identity, until: now() + VERIFY_CACHE_MS });
			}
			return identity;
		},
		revoke(uid: string): void {
			revokedAt.set(uid, ++sequence);
			for (const [k, v] of entries) if (v.identity.uid === uid) entries.delete(k);
		},
		clear(): void {
			entries.clear();
		}
	};
}

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

const verifyCache = cachedVerify(async (cookie) => {
	try {
		return identityOf(await getAuth(app()).verifySessionCookie(cookie, true));
	} catch (error) {
		if (isInvalidSession(error)) return null;
		throw new AuthUnavailableError(error);
	}
});

const adminVerifier: SessionVerifier = {
	async exchange(idToken, ttlMs) {
		const auth = getAuth(app());
		const claims = await auth.verifyIdToken(idToken, true);
		if (Date.now() - claims.auth_time * 1000 > FRESH_SIGN_IN_MS) return null;
		const cookie = await auth.createSessionCookie(idToken, { expiresIn: ttlMs });
		return { cookie, identity: identityOf(claims) };
	},
	verify: verifyCache.verify,
	async revoke(uid) {
		verifyCache.revoke(uid);
		try {
			await getAuth(app()).revokeRefreshTokens(uid);
		} finally {
			verifyCache.revoke(uid);
		}
	}
};

let current: SessionVerifier = adminVerifier;

export const sessionVerifier: SessionVerifier = {
	exchange: (idToken, ttlMs) => current.exchange(idToken, ttlMs),
	verify: (cookie) => current.verify(cookie),
	revoke: (uid) => current.revoke(uid)
};

export function setSessionVerifier(verifier: SessionVerifier | null): void {
	current = verifier ?? adminVerifier;
}
