import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { OAUTH_REDIRECT_URIS, getClient } from './oauth.ts';
import { handleRegistration } from './oauth-register.ts';
import { resetThrottle } from './throttle.ts';

const CALLBACK = OAUTH_REDIRECT_URIS[0];
const NOW = new Date('2026-01-01T00:00:00Z');

let db: Db;
beforeEach(() => {
	db = testDb();
	resetThrottle();
});

function post(
	body: unknown,
	headers: Record<string, string> = { 'content-type': 'application/json' }
) {
	return new Request('http://localhost/oauth/register', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

const register = (body: unknown, address = '10.0.0.1', headers?: Record<string, string>) =>
	handleRegistration(db, post(body, headers), address, NOW);

describe('handleRegistration', () => {
	it('registers a public client', async () => {
		const res = await register({ client_name: 'Claude', redirect_uris: [CALLBACK] });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toEqual({
			client_id: expect.any(String),
			client_name: 'Claude',
			redirect_uris: [CALLBACK],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			client_id_issued_at: NOW.getTime() / 1000
		});
		expect(getClient(db, body.client_id)).toMatchObject({
			name: 'Claude',
			redirectUris: [CALLBACK],
			authMethod: 'none'
		});
	});

	it('issues a secret for client_secret_post', async () => {
		const res = await register({
			redirect_uris: [CALLBACK],
			token_endpoint_auth_method: 'client_secret_post',
			scope: 'ignored'
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.token_endpoint_auth_method).toBe('client_secret_post');
		expect(body.client_secret).toEqual(expect.any(String));
		expect(body.client_secret_expires_at).toBe(0);
		expect(body).not.toHaveProperty('scope');
		expect(getClient(db, body.client_id)?.authMethod).toBe('client_secret_post');
	});

	it('sets cache-control: no-store', async () => {
		const ok = await register({ redirect_uris: [CALLBACK] });
		const bad = await register('nope');
		expect(ok.headers.get('cache-control')).toBe('no-store');
		expect(bad.headers.get('cache-control')).toBe('no-store');
	});

	it.each([
		['not JSON', '{nope'],
		['a JSON array', [{ redirect_uris: [CALLBACK] }]],
		['a JSON scalar', 'null']
	])('rejects %s', async (_label, body) => {
		const res = await register(body);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid_client_metadata');
	});

	it('rejects a non-JSON content type', async () => {
		const res = await register({ redirect_uris: [CALLBACK] }, '10.0.0.1', {
			'content-type': 'text/plain'
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid_client_metadata');
	});

	it('rejects an unregistered redirect URI', async () => {
		const res = await register({ redirect_uris: ['https://evil.example/cb'] });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: 'invalid_redirect_uri',
			error_description: expect.any(String)
		});
	});

	it.each([
		['auth method', { token_endpoint_auth_method: 'private_key_jwt' }],
		['client name', { client_name: 42 }]
	])('rejects a bad %s', async (_label, extra) => {
		const res = await register({ redirect_uris: [CALLBACK], ...extra });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid_client_metadata');
	});

	it('throttles the 9th attempt from one address, successful or not', async () => {
		for (let i = 0; i < 4; i++) {
			expect((await register({ redirect_uris: [CALLBACK] })).status).toBe(201);
			expect((await register('nope')).status).toBe(400);
		}
		const res = await register({ redirect_uris: [CALLBACK] });
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ error: 'invalid_request' });
		expect(res.headers.get('cache-control')).toBe('no-store');

		expect((await register({ redirect_uris: [CALLBACK] }, '10.0.0.2')).status).toBe(201);
	});
});
