import { readFileSync } from 'node:fs';
import { redirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import {
	OAUTH_REDIRECT_ORIGINS,
	consentRedirect,
	readAuthorizeRequest
} from './oauth-authorize.ts';
import { OAUTH_REDIRECT_URIS, registerClient, type OAuthClient } from './oauth.ts';

const ORIGIN = 'https://sagas.example';
const CALLBACK = OAUTH_REDIRECT_URIS[0];
const CHALLENGE = 'a'.repeat(43);

let db: Db;
let client: OAuthClient;

beforeEach(() => {
	db = testDb();
	client = registerClient(db, { name: 'Claude', redirectUris: [...OAUTH_REDIRECT_URIS] }).client;
});

afterEach(() => {
	db.$client.close();
});

function request(overrides: Record<string, string | null> = {}, extra: [string, string][] = []) {
	const base: Record<string, string> = {
		response_type: 'code',
		client_id: client.clientId,
		redirect_uri: CALLBACK,
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		state: 'xyz'
	};
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries({ ...base, ...overrides })) {
		if (value !== null) params.set(key, value);
	}
	for (const [key, value] of extra) params.append(key, value);
	return readAuthorizeRequest(db, params, ORIGIN);
}

function redirected(result: ReturnType<typeof request>) {
	expect(result.kind).toBe('redirect');
	if (result.kind !== 'redirect') throw new Error('not a redirect');
	const url = new URL(result.location);
	return { url, error: url.searchParams.get('error'), state: url.searchParams.get('state') };
}

describe('readAuthorizeRequest', () => {
	it('returns the consent details for a good request', () => {
		expect(request()).toEqual({
			kind: 'consent',
			client,
			redirectUri: CALLBACK,
			codeChallenge: CHALLENGE,
			state: 'xyz'
		});
	});

	it('takes state as optional and scope as ignored', () => {
		const result = request({ state: null, scope: 'anything' });
		expect(result).toMatchObject({ kind: 'consent', state: null });
	});

	it('accepts a resource equal to this origin’s /mcp', () => {
		expect(request({ resource: `${ORIGIN}/mcp` }).kind).toBe('consent');
	});

	it.each([
		['no client_id', { client_id: null }],
		['an unknown client_id', { client_id: 'wlc_nope' }],
		['no redirect_uri', { redirect_uri: null }],
		['an unregistered redirect_uri', { redirect_uri: 'https://evil.example/cb' }],
		['a redirect_uri differing only by query', { redirect_uri: `${CALLBACK}?x=1` }],
		['a redirect_uri differing only by trailing slash', { redirect_uri: `${CALLBACK}/` }]
	])('refuses with an error page, never a redirect, for %s', (_name, overrides) => {
		expect(request(overrides).kind).toBe('invalid');
	});

	it('refuses a repeated client_id or redirect_uri', () => {
		expect(request({}, [['client_id', client.clientId]]).kind).toBe('invalid');
		expect(request({}, [['redirect_uri', CALLBACK]]).kind).toBe('invalid');
	});

	it('redirects unsupported_response_type, echoing state', () => {
		const result = redirected(request({ response_type: 'token' }));
		expect(result).toMatchObject({ error: 'unsupported_response_type', state: 'xyz' });
		expect(result.url.origin + result.url.pathname).toBe(CALLBACK);
		expect(result.url.searchParams.get('error_description')).toBeTruthy();
		expect(redirected(request({ response_type: null })).error).toBe('unsupported_response_type');
	});

	it.each([
		['a missing code_challenge', { code_challenge: null }],
		['a plain method', { code_challenge_method: 'plain' }],
		['a missing method', { code_challenge_method: null }],
		['a short challenge', { code_challenge: 'a'.repeat(42) }],
		['a long challenge', { code_challenge: 'a'.repeat(44) }],
		['a challenge with bad characters', { code_challenge: `${'a'.repeat(42)}=` }]
	])('redirects invalid_request for %s', (_name, overrides) => {
		expect(redirected(request(overrides)).error).toBe('invalid_request');
	});

	it('redirects invalid_request for a repeated parameter', () => {
		expect(redirected(request({}, [['code_challenge', CHALLENGE]])).error).toBe('invalid_request');
		const repeated = redirected(request({}, [['state', 'again']]));
		expect(repeated.error).toBe('invalid_request');
		expect(repeated.state).toBe('xyz');
	});

	it('redirects invalid_target for another resource', () => {
		expect(redirected(request({ resource: 'https://other.example/mcp' })).error).toBe(
			'invalid_target'
		);
		expect(redirected(request({ resource: ORIGIN })).error).toBe('invalid_target');
	});

	it('leaves state off an error redirect when none was given', () => {
		expect(redirected(request({ response_type: 'token', state: null })).state).toBeNull();
	});
});

describe('consentRedirect', () => {
	it('appends params to the callback', () => {
		const url = new URL(consentRedirect(CALLBACK, { code: 'c', state: 's' }));
		expect(url.origin + url.pathname).toBe(CALLBACK);
		expect(Object.fromEntries(url.searchParams)).toEqual({ code: 'c', state: 's' });
	});

	it('keeps a query already on the callback and escapes values', () => {
		const url = new URL(consentRedirect(`${CALLBACK}?keep=1`, { state: 'a&b=c d' }));
		expect(url.searchParams.get('keep')).toBe('1');
		expect(url.searchParams.get('state')).toBe('a&b=c d');
		expect(url.searchParams.getAll('b')).toEqual([]);
	});
});

describe('external redirect allowlist', () => {
	it('lets Kit redirect to every registered callback', () => {
		for (const uri of OAUTH_REDIRECT_URIS) {
			const location = consentRedirect(uri, { code: 'c', state: 's' });
			expect(() => redirect(303, location, { external: OAUTH_REDIRECT_ORIGINS })).toThrow(
				expect.objectContaining({ status: 303, location })
			);
		}
	});

	it('refuses a host outside the registered callbacks', () => {
		expect(() =>
			redirect(303, 'https://evil.example/cb?code=c', { external: OAUTH_REDIRECT_ORIGINS })
		).toThrow(/not included in the `external` allowlist/);
	});
});

describe('CSP form-action', () => {
	it('lists the origin of every registered callback', () => {
		const config = readFileSync(new URL('../../../../vite.config.ts', import.meta.url), 'utf8');
		const line = config.split('\n').find((l) => l.includes("'form-action'"));
		expect(line).toBeDefined();
		for (const origin of OAUTH_REDIRECT_ORIGINS) expect(line).toContain(`'${origin}'`);
	});
});
