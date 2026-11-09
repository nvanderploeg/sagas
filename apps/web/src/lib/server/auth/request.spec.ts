import type { Cookies } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AuthUnavailableError,
	cachedVerify,
	isInvalidSession,
	setSessionVerifier,
	VERIFY_CACHE_MS
} from './firebase.ts';
import { skipsCookieAuth } from './access.ts';
import type { AuthUser } from './users.ts';
import {
	authFromRequest,
	clearSessionCookie,
	endSession,
	isUniqueViolation,
	SESSION_COOKIE,
	signInOrFind,
	setSessionCookie
} from './request.ts';

function recordingCookies() {
	const calls: { name: string; options: { secure?: boolean } }[] = [];
	const cookies = {
		set: (name: string, _value: string, options: { secure?: boolean }) =>
			calls.push({ name, options }),
		delete: (name: string, options: { secure?: boolean }) => calls.push({ name, options })
	} as unknown as Cookies;
	return { cookies, calls };
}

describe('session cookie', () => {
	const expires = new Date('2026-01-01T00:00:00Z');

	it.each([
		['http://localhost:3290/login', false],
		['http://192.168.1.20:3290/login', false],
		['https://sagas.example.com/login', true]
	])('is Secure exactly when the request protocol is https (%s)', (href, secure) => {
		const { cookies, calls } = recordingCookies();

		setSessionCookie(cookies, new URL(href), 'wls_token', expires);
		clearSessionCookie(cookies, new URL(href));

		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.name).toBe(SESSION_COOKIE);
			expect(call.options.secure).toBe(secure);
		}
	});
});

function jar(token?: string) {
	const deleted: string[] = [];
	const cookies = {
		get: () => token,
		delete: (name: string) => deleted.push(name)
	} as unknown as Cookies;
	return { cookies, deleted };
}

describe('endSession', () => {
	const url = new URL('http://localhost/');
	afterEach(() => setSessionVerifier(null));

	it('revokes the uid behind the cookie and clears it', async () => {
		const revoke = vi.fn(() => Promise.resolve());
		setSessionVerifier({
			exchange: () => Promise.resolve(null),
			verify: () =>
				Promise.resolve({ uid: 'u1', email: 'a@x.test', emailVerified: true, name: null }),
			revoke
		});
		const { cookies, deleted } = jar('tok');

		await endSession(cookies, url);

		expect(revoke).toHaveBeenCalledWith('u1');
		expect(deleted).toEqual([SESSION_COOKIE]);
	});

	it.each(['verify', 'revoke'] as const)('still clears the cookie when %s fails', async (stage) => {
		setSessionVerifier({
			exchange: () => Promise.resolve(null),
			verify: () =>
				stage === 'verify'
					? Promise.reject(new AuthUnavailableError('down'))
					: Promise.resolve({ uid: 'u1', email: null, emailVerified: true, name: null }),
			revoke: () => Promise.reject(new Error('down'))
		});
		const { cookies, deleted } = jar('tok');

		await endSession(cookies, url);

		expect(deleted).toEqual([SESSION_COOKIE]);
	});

	it('does not revoke when the cookie no longer verifies', async () => {
		const revoke = vi.fn(() => Promise.resolve());
		setSessionVerifier({
			exchange: () => Promise.resolve(null),
			verify: () => Promise.resolve(null),
			revoke
		});
		const { cookies, deleted } = jar('tok');

		await endSession(cookies, url);

		expect(revoke).not.toHaveBeenCalled();
		expect(deleted).toEqual([SESSION_COOKIE]);
	});
});

describe('a Firebase outage', () => {
	afterEach(() => setSessionVerifier(null));

	it('propagates from authFromRequest instead of reading as signed out', async () => {
		setSessionVerifier({
			exchange: () => Promise.resolve(null),
			verify: () => Promise.reject(new AuthUnavailableError('down')),
			revoke: () => Promise.resolve()
		});

		await expect(
			authFromRequest(null as never, new Request('http://x/'), 'tok')
		).rejects.toBeInstanceOf(AuthUnavailableError);
	});
});

describe('isInvalidSession', () => {
	it('separates Firebase refusals from its own failures', () => {
		expect(isInvalidSession({ code: 'auth/session-cookie-revoked' })).toBe(true);
		expect(isInvalidSession({ code: 'auth/session-cookie-expired' })).toBe(true);
		expect(isInvalidSession({ code: 'auth/argument-error' })).toBe(true);
		expect(isInvalidSession({ code: 'auth/id-token-expired' })).toBe(true);
		expect(isInvalidSession({ code: 'auth/id-token-revoked' })).toBe(true);
		expect(isInvalidSession({ code: 'auth/invalid-id-token' })).toBe(true);
		expect(isInvalidSession({ code: 'auth/internal-error' })).toBe(false);
		expect(isInvalidSession({ code: 'auth/user-not-found' })).toBe(false);
		expect(isInvalidSession({ code: 'auth/network-error' })).toBe(false);
		expect(isInvalidSession({ code: 'auth/some-new-code' })).toBe(false);
		expect(isInvalidSession(null)).toBe(false);
		expect(isInvalidSession({ code: 'app/network-error' })).toBe(false);
		expect(isInvalidSession(new Error('ECONNRESET'))).toBe(false);
	});
});

describe('cachedVerify', () => {
	const who = { uid: 'u1', email: null, emailVerified: true, name: null };

	it('asks Firebase once per cookie within the window, again after it', async () => {
		let t = 0;
		const inner = vi.fn(() => Promise.resolve(who));
		const cache = cachedVerify(inner, () => t);

		await cache.verify('a');
		await cache.verify('a');
		expect(inner).toHaveBeenCalledTimes(1);
		await cache.verify('b');
		expect(inner).toHaveBeenCalledTimes(2);
		t = VERIFY_CACHE_MS + 1;
		await cache.verify('a');
		expect(inner).toHaveBeenCalledTimes(3);
	});

	it('never keeps a refusal or an error, and clear() forgets everything', async () => {
		const inner = vi
			.fn<(c: string) => Promise<typeof who | null>>()
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('down'))
			.mockResolvedValue(who);
		const cache = cachedVerify(inner);

		expect(await cache.verify('a')).toBeNull();
		await expect(cache.verify('a')).rejects.toThrow();
		expect(await cache.verify('a')).toEqual(who);
		await cache.verify('a');
		expect(inner).toHaveBeenCalledTimes(3);
		cache.clear();
		await cache.verify('a');
		expect(inner).toHaveBeenCalledTimes(4);
	});
});

describe('cachedVerify revoke', () => {
	const who = (uid: string) => ({ uid, email: null, emailVerified: true, name: null });

	it('drops only that uid and does not cache a verify already in flight', async () => {
		let release!: () => void;
		const gated = new Promise<void>((resolve) => (release = resolve));
		const inner = vi.fn(async (cookie: string) => {
			if (cookie === 'slow') await gated;
			return who(cookie === 'other' ? 'u2' : 'u1');
		});
		const cache = cachedVerify(inner);

		await cache.verify('other');
		const pending = cache.verify('slow');
		cache.revoke('u1');
		release();
		await pending;
		await cache.verify('slow');
		await cache.verify('other');

		expect(inner).toHaveBeenCalledTimes(3);
	});

	it('caches again for a verify that starts after the revoke', async () => {
		const inner = vi.fn(() => Promise.resolve(who('u1')));
		const cache = cachedVerify(inner);

		cache.revoke('u1');
		await cache.verify('a');
		await cache.verify('a');

		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe('signInOrFind', () => {
	const identity = { uid: 'u1', email: 'a@x.test', emailVerified: true, name: null };
	const user = { id: 1, username: 'a' } as AuthUser;
	const db = null as never;

	it('reads the winner after losing a unique-violation race', async () => {
		const unique = Object.assign(new Error('dup'), { code: '23505' });
		const found = await signInOrFind(db, identity, new Set(), {
			signIn: () => Promise.reject(new Error('query failed', { cause: unique })),
			find: () => Promise.resolve(user)
		});
		expect(found).toBe(user);
	});

	it('rethrows other errors, and a violation with no winner', async () => {
		const boom = new Error('boom');
		await expect(
			signInOrFind(db, identity, new Set(), {
				signIn: () => Promise.reject(boom),
				find: () => Promise.resolve(user)
			})
		).rejects.toBe(boom);
		const dup = Object.assign(new Error('dup'), { code: '23505' });
		await expect(
			signInOrFind(db, identity, new Set(), {
				signIn: () => Promise.reject(dup),
				find: () => Promise.resolve(null)
			})
		).rejects.toBe(dup);
	});

	it('recognises 23505 on the error or its cause only', () => {
		expect(isUniqueViolation({ code: '23505' })).toBe(true);
		expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
		expect(isUniqueViolation({ code: '23503' })).toBe(false);
		expect(isUniqueViolation(null)).toBe(false);
	});
});

describe('skipsCookieAuth', () => {
	it('covers sign-in and sign-out paths only', () => {
		for (const path of ['/login', '/logout', '/api/auth/session', '/api/auth/config']) {
			expect(skipsCookieAuth(path), path).toBe(true);
		}
		for (const path of ['/', '/login/session', '/api/labours', '/api/authx', '/mcp']) {
			expect(skipsCookieAuth(path), path).toBe(false);
		}
	});
});
