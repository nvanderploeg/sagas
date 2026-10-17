import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedHuman } from './fixtures.ts';
import { handleTokenRequest } from './oauth-token.ts';
import {
	ACCESS_TOKEN_TTL_MS,
	OAUTH_REDIRECT_URIS,
	OAUTH_SCOPE,
	issueCode,
	registerClient,
	type OAuthClient
} from './oauth.ts';
import { verifyApiToken } from './tokens.ts';
import type { AuthUser } from './users.ts';

const ORIGIN = 'https://sagas.example';
const CALLBACK = OAUTH_REDIRECT_URIS[0];
const T0 = new Date('2026-01-01T00:00:00Z');
const VERIFIER = 'a'.repeat(43);
const FORM = 'application/x-www-form-urlencoded';

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const basic = (id: string, secret: string) =>
	`Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

let db: Db;
let ada: AuthUser;

beforeEach(() => {
	db = testDb();
	ada = seedHuman(db, 'ada');
});

afterEach(() => {
	db.$client.close();
});

function client(authMethod: 'none' | 'client_secret_post' | 'client_secret_basic' = 'none') {
	const { client, clientSecret } = registerClient(db, { redirectUris: [CALLBACK], authMethod }, T0);
	return { client, secret: clientSecret };
}

function code(c: OAuthClient, now = T0) {
	return issueCode(
		db,
		{
			clientId: c.clientId,
			userId: ada.id,
			redirectUri: CALLBACK,
			codeChallenge: challengeOf(VERIFIER),
			codeChallengeMethod: 'S256'
		},
		now
	);
}

function post(
	params: Record<string, string>,
	headers: Record<string, string> = {},
	now = T0,
	body: string = new URLSearchParams(params).toString()
) {
	return handleTokenRequest(
		db,
		new Request(`${ORIGIN}/oauth/token`, {
			method: 'POST',
			headers: { 'content-type': FORM, ...headers },
			body
		}),
		ORIGIN,
		now
	);
}

function exchangeParams(c: OAuthClient, extra: Record<string, string> = {}) {
	return {
		grant_type: 'authorization_code',
		code: code(c),
		redirect_uri: CALLBACK,
		code_verifier: VERIFIER,
		...extra
	};
}

async function expectError(
	response: Response,
	status: number,
	error: string,
	headers: Record<string, string | null> = {}
) {
	expect(response.status).toBe(status);
	expect(((await response.json()) as { error: string }).error).toBe(error);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('pragma')).toBe('no-cache');
	for (const [name, value] of Object.entries(headers)) {
		expect(response.headers.get(name)).toBe(value);
	}
}

type Tokens = {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
	scope: string;
};

async function expectTokens(response: Response): Promise<Tokens> {
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('pragma')).toBe('no-cache');
	const body = (await response.json()) as Tokens;
	expect(body.token_type).toBe('Bearer');
	expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_MS / 1000);
	expect(body.scope).toBe(OAUTH_SCOPE);
	return body;
}

describe('authorization_code grant', () => {
	it('exchanges a code for tokens a public client can use', async () => {
		const { client: c } = client();
		const tokens = await expectTokens(await post({ ...exchangeParams(c), client_id: c.clientId }));

		expect(tokens.access_token).toMatch(/^wlt_/);
		expect(verifyApiToken(db, tokens.access_token, T0)?.id).toBe(ada.id);
	});

	it('authenticates a confidential client with Basic', async () => {
		const { client: c, secret } = client('client_secret_basic');
		const tokens = await expectTokens(
			await post(exchangeParams(c), { authorization: basic(c.clientId, secret!) })
		);
		expect(verifyApiToken(db, tokens.access_token, T0)?.id).toBe(ada.id);
	});

	it('authenticates a confidential client with the secret in the body', async () => {
		const { client: c, secret } = client('client_secret_post');
		const tokens = await expectTokens(
			await post({ ...exchangeParams(c), client_id: c.clientId, client_secret: secret! })
		);
		expect(verifyApiToken(db, tokens.access_token, T0)?.id).toBe(ada.id);
	});

	it('accepts a body client_id equal to the Basic one', async () => {
		const { client: c, secret } = client('client_secret_basic');
		await expectTokens(
			await post(
				{ ...exchangeParams(c), client_id: c.clientId },
				{ authorization: basic(c.clientId, secret!) }
			)
		);
	});

	it('ignores unknown parameters and scope', async () => {
		const { client: c } = client();
		await expectTokens(
			await post({ ...exchangeParams(c), client_id: c.clientId, scope: 'other', extra: 'x' })
		);
	});

	it('accepts the Resource as resource', async () => {
		const { client: c } = client();
		await expectTokens(
			await post({ ...exchangeParams(c), client_id: c.clientId, resource: `${ORIGIN}/mcp` })
		);
	});

	it('refuses another resource with invalid_target', async () => {
		const { client: c } = client();
		await expectError(
			await post({ ...exchangeParams(c), client_id: c.clientId, resource: `${ORIGIN}/other` }),
			400,
			'invalid_target'
		);
	});

	it('fails invalid_grant for a wrong verifier, then a replayed code', async () => {
		const { client: c } = client();
		const params = { ...exchangeParams(c), client_id: c.clientId };
		await expectError(
			await post({ ...params, code_verifier: 'b'.repeat(43) }),
			400,
			'invalid_grant'
		);
		await expectTokens(await post(params));
		await expectError(await post(params), 400, 'invalid_grant');
	});

	it('fails invalid_grant for an expired code', async () => {
		const { client: c } = client();
		const params = { ...exchangeParams(c), client_id: c.clientId };
		await expectError(
			await post(params, {}, new Date(T0.getTime() + 24 * 60 * 60 * 1000)),
			400,
			'invalid_grant'
		);
	});

	it('requires code, redirect_uri and code_verifier', async () => {
		const { client: c } = client();
		for (const missing of ['code', 'redirect_uri', 'code_verifier']) {
			const params: Record<string, string> = { ...exchangeParams(c), client_id: c.clientId };
			delete params[missing];
			await expectError(await post(params), 400, 'invalid_request');
		}
	});
});

describe('refresh_token grant', () => {
	it('rotates the refresh token and the old access token stops working', async () => {
		const { client: c, secret } = client('client_secret_basic');
		const auth = { authorization: basic(c.clientId, secret!) };
		const first = await expectTokens(await post(exchangeParams(c), auth));

		const later = new Date(T0.getTime() + ACCESS_TOKEN_TTL_MS / 2);
		const second = await expectTokens(
			await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token }, auth, later)
		);

		expect(second.refresh_token).not.toBe(first.refresh_token);
		expect(verifyApiToken(db, first.access_token, later)).toBeNull();
		expect(verifyApiToken(db, second.access_token, later)?.id).toBe(ada.id);
	});

	it('refreshes for a public client', async () => {
		const { client: c } = client();
		const first = await expectTokens(await post({ ...exchangeParams(c), client_id: c.clientId }));
		await expectTokens(
			await post({
				grant_type: 'refresh_token',
				refresh_token: first.refresh_token,
				client_id: c.clientId
			})
		);
	});

	it('requires refresh_token', async () => {
		const { client: c } = client();
		await expectError(
			await post({ grant_type: 'refresh_token', client_id: c.clientId }),
			400,
			'invalid_request'
		);
	});

	it('fails invalid_grant for an unknown refresh token and a replayed one', async () => {
		const { client: c } = client();
		const base = { client_id: c.clientId };
		await expectError(
			await post({ ...base, grant_type: 'refresh_token', refresh_token: 'wlr_nope' }),
			400,
			'invalid_grant'
		);

		const first = await expectTokens(await post({ ...exchangeParams(c), ...base }));
		const refresh = { ...base, grant_type: 'refresh_token', refresh_token: first.refresh_token };
		const second = await expectTokens(await post(refresh));
		await expectError(await post(refresh), 400, 'invalid_grant');
		expect(verifyApiToken(db, second.access_token, T0)).toBeNull();
	});
});

describe('request shape', () => {
	it('refuses a body that is not form-urlencoded', async () => {
		const { client: c } = client();
		for (const type of ['application/json', 'multipart/form-data']) {
			await expectError(
				await post(
					{ client_id: c.clientId },
					{ 'content-type': type },
					T0,
					JSON.stringify({ grant_type: 'refresh_token' })
				),
				400,
				'invalid_request'
			);
		}
	});

	it('refuses a missing content type', async () => {
		const response = await handleTokenRequest(
			db,
			new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body: new Uint8Array() }),
			ORIGIN,
			T0
		);
		await expectError(response, 400, 'invalid_request');
	});

	it('accepts a charset on the content type', async () => {
		const { client: c } = client();
		await expectTokens(
			await post(
				{ ...exchangeParams(c), client_id: c.clientId },
				{ 'content-type': `${FORM}; charset=UTF-8` }
			)
		);
	});

	it('refuses a repeated parameter', async () => {
		const { client: c } = client();
		await expectError(
			await post(
				{},
				{},
				T0,
				`client_id=${c.clientId}&grant_type=refresh_token&grant_type=refresh_token`
			),
			400,
			'invalid_request'
		);
	});

	it('requires grant_type and refuses unknown ones', async () => {
		const { client: c } = client();
		await expectError(await post({ client_id: c.clientId }), 400, 'invalid_request');
		await expectError(
			await post({ client_id: c.clientId, grant_type: 'password' }),
			400,
			'unsupported_grant_type'
		);
	});
});

describe('client authentication', () => {
	it('answers invalid_client with no client id at all', async () => {
		await expectError(
			await post({ grant_type: 'refresh_token', refresh_token: 'x' }),
			401,
			'invalid_client',
			{ 'www-authenticate': null }
		);
	});

	it('answers invalid_client for an unknown client, challenging only Basic', async () => {
		await expectError(
			await post({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'wlc_nope' }),
			401,
			'invalid_client',
			{ 'www-authenticate': null }
		);
		await expectError(
			await post(
				{ grant_type: 'refresh_token', refresh_token: 'x' },
				{ authorization: basic('wlc_nope', 'wlk_nope') }
			),
			401,
			'invalid_client',
			{ 'www-authenticate': 'Basic' }
		);
	});

	it('refuses a confidential client with a missing or wrong secret', async () => {
		const { client: c } = client('client_secret_post');
		const params = { ...exchangeParams(c), client_id: c.clientId };
		await expectError(await post(params), 401, 'invalid_client');
		await expectError(await post({ ...params, client_secret: 'wlk_wrong' }), 401, 'invalid_client');
	});

	it('refuses a wrong Basic secret with a Basic challenge', async () => {
		const { client: c } = client('client_secret_basic');
		await expectError(
			await post(exchangeParams(c), { authorization: basic(c.clientId, 'wlk_wrong') }),
			401,
			'invalid_client',
			{ 'www-authenticate': 'Basic' }
		);
	});

	it('refuses malformed Basic credentials as invalid_client', async () => {
		const { client: c } = client();
		for (const credentials of ['!!!', Buffer.from('nocolon').toString('base64')]) {
			await expectError(
				await post(exchangeParams(c), { authorization: `Basic ${credentials}` }),
				401,
				'invalid_client',
				{ 'www-authenticate': 'Basic' }
			);
		}
	});

	it('refuses Basic together with a body client_secret', async () => {
		const { client: c, secret } = client('client_secret_basic');
		await expectError(
			await post(
				{ ...exchangeParams(c), client_secret: secret! },
				{ authorization: basic(c.clientId, secret!) }
			),
			400,
			'invalid_request'
		);
	});

	it('refuses a body client_id that differs from the Basic one', async () => {
		const { client: c, secret } = client('client_secret_basic');
		await expectError(
			await post(
				{ ...exchangeParams(c), client_id: 'wlc_other' },
				{ authorization: basic(c.clientId, secret!) }
			),
			400,
			'invalid_request'
		);
	});

	it('refuses a code issued to another client as invalid_grant', async () => {
		const { client: a } = client();
		const { client: b } = client();
		await expectError(
			await post({ ...exchangeParams(a), client_id: b.clientId }),
			400,
			'invalid_grant'
		);
	});

	it('form-decodes Basic parts', async () => {
		const { client: c, secret } = client('client_secret_basic');
		const escape = (text: string) =>
			[...text].map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
		const encoded = Buffer.from(`${escape(c.clientId)}:${escape(secret!)}`).toString('base64');
		await expectTokens(await post(exchangeParams(c), { authorization: `basic ${encoded}` }));
	});

	it('refuses Basic credentials with a bad escape or an empty id', async () => {
		const { client: c } = client('client_secret_basic');
		for (const raw of [`${c.clientId}:%zz`, ':secret']) {
			const authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
			await expectError(await post(exchangeParams(c), { authorization }), 401, 'invalid_client', {
				'www-authenticate': 'Basic'
			});
		}
	});

	it('treats an empty client_secret beside Basic as absent', async () => {
		const { client: c, secret } = client('client_secret_basic');
		await expectTokens(
			await post(
				{ ...exchangeParams(c), client_secret: '' },
				{ authorization: basic(c.clientId, secret!) }
			)
		);
	});

	it('treats an empty resource as absent and accepts a repeated matching one', async () => {
		const { client: c } = client();
		await expectTokens(await post({ ...exchangeParams(c), client_id: c.clientId, resource: '' }));
		const params = new URLSearchParams({ ...exchangeParams(c), client_id: c.clientId });
		params.append('resource', `${ORIGIN}/mcp`);
		params.append('resource', `${ORIGIN}/mcp`);
		params.append('scope', 'a');
		params.append('scope', 'b');
		await expectTokens(await post({}, {}, T0, params.toString()));
	});

	it('refuses a repeated resource when any copy is another server', async () => {
		const { client: c } = client();
		const params = new URLSearchParams({ ...exchangeParams(c), client_id: c.clientId });
		params.append('resource', `${ORIGIN}/mcp`);
		params.append('resource', 'https://other.example/mcp');
		await expectError(await post({}, {}, T0, params.toString()), 400, 'invalid_target');
	});
});
