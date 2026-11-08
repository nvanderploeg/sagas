import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	apiTokens,
	oauthClients,
	oauthCodes,
	oauthGrants,
	oauthRefreshTokens
} from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { apiTokenCredential, credentialValid, onRevoked, type Credential } from './credentials.ts';
import { seedHuman } from './fixtures.ts';
import {
	ACCESS_TOKEN_TTL_MS,
	AUTHORIZATION_CODE_TTL_MS,
	OAUTH_REDIRECT_URIS,
	OAUTH_SCOPE,
	REFRESH_TOKEN_TTL_MS,
	OAuthError,
	authenticateClient,
	exchangeCode,
	getClient,
	issueCode,
	pruneOAuth,
	refreshGrant,
	registerClient,
	revokeGrant,
	type ClientAuthMethod,
	type OAuthClient,
	type OAuthErrorCode,
	type TokenSet
} from './oauth.ts';
import { hashSecret } from './secrets.ts';
import { createApiToken, listApiTokens, revokeApiToken, verifyApiToken } from './tokens.ts';
import type { AuthUser } from './users.ts';
import { inTransaction } from '#lib/server/db/tx.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs);

const [URI_A, URI_B] = OAUTH_REDIRECT_URIS;

let db: Db;
let grace: AuthUser;
let heard: Credential[];
let stopListening: () => void;

beforeEach(async () => {
	db = await testDb();
	grace = await seedHuman(db, 'grace');
	heard = [];
	stopListening = onRevoked((credential) => heard.push(credential));
});

afterEach(() => {
	stopListening();
});

async function expectOAuth(action: () => unknown, code: OAuthErrorCode) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(OAuthError);
	expect((thrown as OAuthError).error).toBe(code);
}

function pkce(verifier = randomBytes(32).toString('base64url')) {
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function newClient(
	authMethod?: ClientAuthMethod,
	name = 'Claude',
	redirectUris: string[] = [URI_A],
	now = T0
) {
	return registerClient(db, { name, redirectUris, authMethod }, now);
}

type Connection = {
	client: OAuthClient;
	clientSecret: string | null;
	tokens: TokenSet;
	grantId: number;
};

async function connect(
	options: { user?: AuthUser; client?: Awaited<ReturnType<typeof newClient>>; now?: Date } = {}
): Promise<Connection> {
	const user = options.user ?? grace;
	const registered = options.client ?? (await newClient());
	const now = options.now ?? T0;
	const { verifier, challenge } = pkce();
	const code = await issueCode(
		db,
		{
			clientId: registered.client.clientId,
			userId: user.id,
			redirectUri: URI_A,
			codeChallenge: challenge,
			codeChallengeMethod: 'S256'
		},
		now
	);
	const tokens = await exchangeCode(
		db,
		{ client: registered.client, code, redirectUri: URI_A, codeVerifier: verifier },
		now
	);
	return { ...registered, tokens, grantId: await grantIdOf(tokens.accessToken) };
}

async function grantIdOf(accessToken: string): Promise<number> {
	const row = (
		await db
			.select({ grantId: apiTokens.grantId })
			.from(apiTokens)
			.where(eq(apiTokens.tokenHash, hashSecret(accessToken)))
			.limit(1)
	)[0];
	return row!.grantId!;
}

function code(client: OAuthClient, challenge: string, now = T0, redirectUri: string = URI_A) {
	return issueCode(
		db,
		{
			clientId: client.clientId,
			userId: grace.id,
			redirectUri,
			codeChallenge: challenge,
			codeChallengeMethod: 'S256'
		},
		now
	);
}

describe('constants', () => {
	it('pins the lifetimes and scope the owner decided', () => {
		expect(ACCESS_TOKEN_TTL_MS).toBe(HOUR);
		expect(REFRESH_TOKEN_TTL_MS).toBe(30 * DAY);
		expect(AUTHORIZATION_CODE_TTL_MS).toBe(10 * 60 * 1000);
		expect(OAUTH_SCOPE).toBe('sagas');
		expect([...OAUTH_REDIRECT_URIS]).toEqual([
			'https://claude.ai/api/mcp/auth_callback',
			'https://claude.com/api/mcp/auth_callback'
		]);
	});
});

describe('OAuthError', () => {
	it('carries the RFC error code and the description', () => {
		const error = new OAuthError('invalid_grant', 'bad code');

		expect(error).toBeInstanceOf(Error);
		expect(error.error).toBe('invalid_grant');
		expect(error.message).toBe('bad code');
	});
});

describe('registerClient', () => {
	it('registers a public client by default, with no secret', async () => {
		const { client, clientSecret } = await registerClient(db, { redirectUris: [URI_A] }, T0);

		expect(clientSecret).toBeNull();
		expect(client.clientId).toMatch(/^wlc_/);
		expect(client.authMethod).toBe('none');
		expect(client.name).toBe('OAuth client');
		expect(client.redirectUris).toEqual([URI_A]);
		expect(client.createdAt).toEqual(T0);
	});

	it('gives every client its own id', async () => {
		expect((await newClient()).client.clientId).not.toBe((await newClient()).client.clientId);
	});

	it.each(['client_secret_post', 'client_secret_basic'] as const)(
		'returns a one-time secret for a %s client and stores only its hash',
		async (authMethod) => {
			const { client, clientSecret } = await newClient(authMethod);

			expect(client.authMethod).toBe(authMethod);
			expect(clientSecret).toMatch(/^wlk_/);
			const row = (
				await db.select().from(oauthClients).where(eq(oauthClients.id, client.clientId)).limit(1)
			)[0]!;
			expect(row.secretHash).toBe(hashSecret(clientSecret!));
			expect(JSON.stringify(row)).not.toContain(clientSecret!);
			expect(JSON.stringify(client)).not.toContain(clientSecret!);
			expect(JSON.stringify(await getClient(db, client.clientId))).not.toContain(clientSecret!);
		}
	);

	it('stores no secret hash for a public client', async () => {
		const { client } = await newClient('none');

		const row = (
			await db.select().from(oauthClients).where(eq(oauthClients.id, client.clientId)).limit(1)
		)[0]!;
		expect(row.secretHash).toBeNull();
	});

	it('accepts every allowed redirect URI together', async () => {
		const { client } = await newClient('none', 'Claude', [URI_A, URI_B]);

		expect(client.redirectUris).toEqual([URI_A, URI_B]);
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['a string', URI_A],
		['an object', { 0: URI_A }],
		['an empty array', []],
		['an array holding a non-string', [URI_A, 7]],
		['an array holding null', [null]]
	])('rejects redirectUris that is %s', async (_label, redirectUris) => {
		await expectOAuth(() => registerClient(db, { redirectUris }, T0), 'invalid_redirect_uri');
	});

	it.each([
		['a foreign host', 'https://evil.example/api/mcp/auth_callback'],
		['plain http', 'http://claude.ai/api/mcp/auth_callback'],
		['a trailing slash', `${URI_A}/`],
		['a query string', `${URI_A}?x=1`],
		['another path on an allowed host', 'https://claude.ai/other'],
		['a different case', URI_A.toUpperCase()],
		['a localhost callback', 'http://localhost:3000/callback']
	])('rejects a redirect URI with %s', async (_label, uri) => {
		await expectOAuth(
			() => registerClient(db, { redirectUris: [uri] }, T0),
			'invalid_redirect_uri'
		);
	});

	it('rejects the whole registration when one of several URIs is not allowed', async () => {
		await expectOAuth(
			() => registerClient(db, { redirectUris: [URI_A, 'https://evil.example/cb'] }, T0),
			'invalid_redirect_uri'
		);
		expect(await db.select().from(oauthClients)).toHaveLength(0);
	});

	it('trims the name', async () => {
		expect((await newClient('none', '  Claude  ')).client.name).toBe('Claude');
	});

	it.each([
		['absent', undefined],
		['empty', ''],
		['blank', '   ']
	])('defaults a %s name to "OAuth client"', async (_label, name) => {
		const { client } = await registerClient(db, { name, redirectUris: [URI_A] }, T0);

		expect(client.name).toBe('OAuth client');
	});

	it('accepts a name of exactly 100 characters', async () => {
		const name = 'n'.repeat(100);

		expect((await newClient('none', name)).client.name).toBe(name);
	});

	it('rejects a name over 100 characters', async () => {
		await expectOAuth(() => newClient('none', 'n'.repeat(101)), 'invalid_client_metadata');
	});

	it.each([
		['a number', 42],
		['an object', {}],
		['an array', ['Claude']],
		['a boolean', true]
	])('rejects a name that is %s', async (_label, name) => {
		await expectOAuth(
			() => registerClient(db, { name, redirectUris: [URI_A] }, T0),
			'invalid_client_metadata'
		);
	});

	it.each(['private_key_jwt', 'CLIENT_SECRET_POST', '', 'basic'])(
		'rejects the unknown auth method %j',
		async (authMethod) => {
			await expectOAuth(
				() => registerClient(db, { redirectUris: [URI_A], authMethod }, T0),
				'invalid_client_metadata'
			);
		}
	);

	it('persists nothing when registration fails', async () => {
		await expectOAuth(
			() => registerClient(db, { redirectUris: [URI_A], authMethod: 'nope' }, T0),
			'invalid_client_metadata'
		);

		expect(await db.select().from(oauthClients)).toHaveLength(0);
	});
});

describe('getClient', () => {
	it('returns the registered client without its secret', async () => {
		const { client, clientSecret } = await newClient('client_secret_post', 'Claude', [
			URI_A,
			URI_B
		]);

		const found = (await getClient(db, client.clientId))!;

		expect(found.clientId).toBe(client.clientId);
		expect(found.name).toBe('Claude');
		expect(found.redirectUris).toEqual([URI_A, URI_B]);
		expect(found.authMethod).toBe('client_secret_post');
		expect(found.createdAt).toEqual(T0);
		expect(JSON.stringify(found)).not.toContain(clientSecret!);
	});

	it('returns null for an unknown client', async () => {
		expect(await getClient(db, 'wlc_nope')).toBeNull();
	});
});

describe('authenticateClient', () => {
	it('rejects an unknown client', async () => {
		await expectOAuth(() => authenticateClient(db, 'wlc_nope', null), 'invalid_client');
	});

	it('lets a public client in without a secret', async () => {
		const { client } = await newClient('none');

		expect((await authenticateClient(db, client.clientId, null)).clientId).toBe(client.clientId);
	});

	it('ignores a secret presented by a public client', async () => {
		const { client } = await newClient('none');

		expect((await authenticateClient(db, client.clientId, 'wlk_whatever')).clientId).toBe(
			client.clientId
		);
	});

	it.each(['client_secret_post', 'client_secret_basic'] as const)(
		'lets a %s client in with its secret',
		async (authMethod) => {
			const { client, clientSecret } = await newClient(authMethod);

			const authenticated = await authenticateClient(db, client.clientId, clientSecret);

			expect(authenticated.clientId).toBe(client.clientId);
			expect(authenticated.authMethod).toBe(authMethod);
			expect(authenticated.redirectUris).toEqual(client.redirectUris);
		}
	);

	it.each(['client_secret_post', 'client_secret_basic'] as const)(
		'rejects a %s client with no secret',
		async (authMethod) => {
			const { client } = await newClient(authMethod);

			await expectOAuth(() => authenticateClient(db, client.clientId, null), 'invalid_client');
		}
	);

	it('rejects a confidential client with a wrong secret', async () => {
		const { client, clientSecret } = await newClient('client_secret_post');

		await expectOAuth(
			() => authenticateClient(db, client.clientId, clientSecret + 'x'),
			'invalid_client'
		);
		await expectOAuth(() => authenticateClient(db, client.clientId, ''), 'invalid_client');
	});

	it('rejects the secret of a different confidential client', async () => {
		const first = await newClient('client_secret_post');
		const second = await newClient('client_secret_post');

		await expectOAuth(
			() => authenticateClient(db, first.client.clientId, second.clientSecret),
			'invalid_client'
		);
	});
});

describe('issueCode', () => {
	it('returns a wla_ code and stores only its hash', async () => {
		const { client } = await newClient();
		const { challenge } = pkce();

		const issued = await code(client, challenge);

		expect(issued).toMatch(/^wla_/);
		const rows = await db.select().from(oauthCodes);
		expect(rows).toHaveLength(1);
		expect(rows[0].codeHash).toBe(hashSecret(issued));
		expect(JSON.stringify(rows[0])).not.toContain(issued);
	});

	it('issues a different code every time', async () => {
		const { client } = await newClient();
		const { challenge } = pkce();

		expect(await code(client, challenge)).not.toBe(await code(client, challenge));
	});

	it('accepts the second registered redirect URI', async () => {
		const { client } = await newClient('none', 'Claude', [URI_A, URI_B]);

		expect(await code(client, pkce().challenge, T0, URI_B)).toMatch(/^wla_/);
	});

	it('accepts base64url characters - and _ in the challenge', async () => {
		const { client } = await newClient();
		const challenge = `-_${'A'.repeat(41)}`;

		expect(await code(client, challenge)).toMatch(/^wla_/);
	});

	it('rejects an unknown client', async () => {
		await expectOAuth(
			() => code({ clientId: 'wlc_nope' } as OAuthClient, pkce().challenge),
			'invalid_client'
		);
	});

	it('rejects a redirect URI the client did not register, even an otherwise allowed one', async () => {
		const { client } = await newClient('none', 'Claude', [URI_A]);

		await expectOAuth(() => code(client, pkce().challenge, T0, URI_B), 'invalid_redirect_uri');
		await expectOAuth(
			() => code(client, pkce().challenge, T0, 'https://evil.example/cb'),
			'invalid_redirect_uri'
		);
		await expectOAuth(
			() => code(client, pkce().challenge, T0, `${URI_A}/`),
			'invalid_redirect_uri'
		);
		await expectOAuth(() => code(client, pkce().challenge, T0, ''), 'invalid_redirect_uri');
	});

	it('reports a bad redirect URI before a bad challenge, so the caller never redirects', async () => {
		const { client } = await newClient();

		await expectOAuth(
			() =>
				issueCode(
					db,
					{
						clientId: client.clientId,
						userId: grace.id,
						redirectUri: 'https://evil.example/cb',
						codeChallenge: 'short',
						codeChallengeMethod: 'plain'
					},
					T0
				),
			'invalid_redirect_uri'
		);
	});

	it.each(['plain', 's256', '', 'S512'])('rejects the challenge method %j', async (method) => {
		const { client } = await newClient();

		await expectOAuth(
			() =>
				issueCode(
					db,
					{
						clientId: client.clientId,
						userId: grace.id,
						redirectUri: URI_A,
						codeChallenge: pkce().challenge,
						codeChallengeMethod: method
					},
					T0
				),
			'invalid_request'
		);
	});

	it.each([
		['too short', 'A'.repeat(42)],
		['too long', 'A'.repeat(44)],
		['empty', ''],
		['padded base64', `${'A'.repeat(42)}=`],
		['standard base64 +', `+${'A'.repeat(42)}`],
		['standard base64 /', `/${'A'.repeat(42)}`],
		['holding a space', ` ${'A'.repeat(42)}`],
		['ending in a newline', `${'A'.repeat(43)}\n`]
	])('rejects a challenge that is %s', async (_label, challenge) => {
		const { client } = await newClient();

		await expectOAuth(() => code(client, challenge), 'invalid_request');
	});

	it('stores no code when validation fails', async () => {
		const { client } = await newClient();

		await expectOAuth(() => code(client, 'short'), 'invalid_request');

		expect(await db.select().from(oauthCodes)).toHaveLength(0);
	});
});

describe('exchangeCode', () => {
	it('returns an access token, a refresh token, the TTL in seconds and the scope', async () => {
		const { tokens } = await connect();

		expect(tokens.accessToken).toMatch(/^wlt_/);
		expect(tokens.refreshToken).toMatch(/^wlr_/);
		expect(tokens.expiresIn).toBe(3600);
		expect(tokens.scope).toBe('sagas');
	});

	it('mints an access token that acts as the consenting User', async () => {
		const { tokens } = await connect({ user: grace });

		expect((await verifyApiToken(db, tokens.accessToken, at(T0, 1000)))?.id).toBe(grace.id);
	});

	it('names the access token "<client> (OAuth)" and flags it as OAuth in the token list', async () => {
		await connect({ client: await newClient('none', 'Claude Desktop') });

		const listed = await listApiTokens(db, grace, grace.id);

		expect(listed).toHaveLength(1);
		expect(listed[0].name).toBe('Claude Desktop (OAuth)');
		expect(listed[0].oauth).toBe(true);
		expect(listed[0].revokedAt).toBeNull();
		expect(listed[0].expiresAt).toEqual(at(T0, ACCESS_TOKEN_TTL_MS));
	});

	it('stores the access token and refresh token only as hashes', async () => {
		const { tokens } = await connect();

		const accessRow = (await db.select().from(apiTokens))[0];
		expect(accessRow.tokenHash).toBe(hashSecret(tokens.accessToken));
		expect(JSON.stringify(accessRow)).not.toContain(tokens.accessToken);
		const refreshRows = await db.select().from(oauthRefreshTokens);
		expect(refreshRows).toHaveLength(1);
		expect(refreshRows[0].tokenHash).toBe(hashSecret(tokens.refreshToken));
		expect(JSON.stringify(refreshRows[0])).not.toContain(tokens.refreshToken);
	});

	it('gives the refresh token a 30 day life', async () => {
		await connect();

		const [row] = await db.select().from(oauthRefreshTokens);

		expect(row.expiresAt).toEqual(at(T0, REFRESH_TOKEN_TTL_MS));
		expect(row.usedAt).toBeNull();
	});

	it('keeps an access token valid strictly before expires_at and refuses it from expires_at on', async () => {
		const { tokens } = await connect();
		const expiry = at(T0, ACCESS_TOKEN_TTL_MS);
		const credential = apiTokenCredential(tokens.accessToken);

		expect((await verifyApiToken(db, tokens.accessToken, at(expiry, -1)))?.id).toBe(grace.id);
		expect(await credentialValid(db, credential, at(expiry, -1))).toBe(true);
		expect(await verifyApiToken(db, tokens.accessToken, expiry)).toBeNull();
		expect(await credentialValid(db, credential, expiry)).toBe(false);
		expect(await verifyApiToken(db, tokens.accessToken, at(expiry, 1))).toBeNull();
		expect(await credentialValid(db, credential, at(expiry, 1))).toBe(false);
	});

	it('creates exactly one grant per exchange and keeps connections independent', async () => {
		const registered = await newClient();
		const one = await connect({ client: registered });
		const two = await connect({ client: registered });

		expect(one.grantId).not.toBe(two.grantId);
		expect(await db.select().from(oauthGrants)).toHaveLength(2);
		expect(one.tokens.accessToken).not.toBe(two.tokens.accessToken);
		expect(one.tokens.refreshToken).not.toBe(two.tokens.refreshToken);

		await revokeGrant(db, one.grantId, T0);

		expect(await verifyApiToken(db, one.tokens.accessToken, T0)).toBeNull();
		expect((await verifyApiToken(db, two.tokens.accessToken, T0))?.id).toBe(grace.id);
		expect(
			(
				await refreshGrant(
					db,
					{ client: registered.client, refreshToken: two.tokens.refreshToken },
					T0
				)
			).accessToken
		).toMatch(/^wlt_/);
	});

	it('records the User who consented, not whoever calls', async () => {
		const ada = await seedHuman(db, 'ada');
		const { tokens } = await connect({ user: ada });

		expect((await verifyApiToken(db, tokens.accessToken, T0))?.id).toBe(ada.id);
		expect(await listApiTokens(db, ada, ada.id)).toHaveLength(1);
		expect(await listApiTokens(db, grace, grace.id)).toHaveLength(0);
	});

	it('accepts a code right up to its 10 minute expiry', async () => {
		const registered = await newClient();
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge, T0);

		const tokens = await exchangeCode(
			db,
			{
				client: registered.client,
				code: issued,
				redirectUri: URI_A,
				codeVerifier: verifier
			},
			at(T0, AUTHORIZATION_CODE_TTL_MS - 1000)
		);

		expect(tokens.accessToken).toMatch(/^wlt_/);
	});

	it('rejects a code after its 10 minute expiry', async () => {
		const registered = await newClient();
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge, T0);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{
						client: registered.client,
						code: issued,
						redirectUri: URI_A,
						codeVerifier: verifier
					},
					at(T0, AUTHORIZATION_CODE_TTL_MS + 1000)
				),
			'invalid_grant'
		);
		expect(await db.select().from(apiTokens)).toHaveLength(0);
	});

	it('rejects an unknown code', async () => {
		const registered = await newClient();

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{
						client: registered.client,
						code: 'wla_unknown',
						redirectUri: URI_A,
						codeVerifier: pkce().verifier
					},
					T0
				),
			'invalid_grant'
		);
	});

	it('rejects a code issued to another client', async () => {
		const owner = await newClient('none', 'Owner');
		const thief = await newClient('none', 'Thief');
		const { verifier, challenge } = pkce();
		const issued = await code(owner.client, challenge);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client: thief.client, code: issued, redirectUri: URI_A, codeVerifier: verifier },
					T0
				),
			'invalid_grant'
		);
		expect(await db.select().from(apiTokens)).toHaveLength(0);
	});

	it('rejects a redirect URI that differs from the one the code was issued for', async () => {
		const registered = await newClient('none', 'Claude', [URI_A, URI_B]);
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge, T0, URI_A);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{
						client: registered.client,
						code: issued,
						redirectUri: URI_B,
						codeVerifier: verifier
					},
					T0
				),
			'invalid_grant'
		);
		expect(await db.select().from(apiTokens)).toHaveLength(0);
	});

	it('rejects a verifier that does not hash to the challenge', async () => {
		const registered = await newClient();
		const { challenge } = pkce();
		const issued = await code(registered.client, challenge);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{
						client: registered.client,
						code: issued,
						redirectUri: URI_A,
						codeVerifier: pkce().verifier
					},
					T0
				),
			'invalid_grant'
		);
		expect(await db.select().from(apiTokens)).toHaveLength(0);
	});

	it('hashes the verifier as base64url without padding, as S256 says', async () => {
		const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
		const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
		const registered = await newClient();
		const issued = await code(registered.client, challenge);

		const tokens = await exchangeCode(
			db,
			{ client: registered.client, code: issued, redirectUri: URI_A, codeVerifier: verifier },
			T0
		);

		expect(tokens.accessToken).toMatch(/^wlt_/);
	});

	it.each([
		['42 characters', 'a'.repeat(42)],
		['129 characters', 'a'.repeat(129)],
		['empty', ''],
		['holding a space', `${'a'.repeat(42)} `],
		['holding a plus', `${'a'.repeat(42)}+`],
		['holding a slash', `${'a'.repeat(42)}/`]
	])('rejects a verifier that is %s as an invalid request', async (_label, verifier) => {
		const registered = await newClient();
		const issued = await code(registered.client, pkce().challenge);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client: registered.client, code: issued, redirectUri: URI_A, codeVerifier: verifier },
					T0
				),
			'invalid_request'
		);
		expect(await db.select().from(apiTokens)).toHaveLength(0);
	});

	it.each([
		['43 characters', 'a'.repeat(43)],
		['128 characters', 'b'.repeat(128)],
		['all of the unreserved punctuation', `a.~_-${'c'.repeat(60)}`]
	])('accepts a verifier that is %s', async (_label, verifier) => {
		const registered = await newClient();
		const issued = await code(registered.client, pkce(verifier).challenge);

		const tokens = await exchangeCode(
			db,
			{ client: registered.client, code: issued, redirectUri: URI_A, codeVerifier: verifier },
			T0
		);

		expect(tokens.accessToken).toMatch(/^wlt_/);
	});

	it('refuses a second exchange of the same code', async () => {
		const registered = await newClient();
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge);
		const input = {
			client: registered.client,
			code: issued,
			redirectUri: URI_A,
			codeVerifier: verifier
		};
		await exchangeCode(db, input, T0);

		await expectOAuth(() => exchangeCode(db, input, at(T0, 1000)), 'invalid_grant');
		expect(await db.select().from(apiTokens)).toHaveLength(1);
	});

	it('revokes the grant when a used code is presented again', async () => {
		const registered = await newClient();
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge);
		const input = {
			client: registered.client,
			code: issued,
			redirectUri: URI_A,
			codeVerifier: verifier
		};
		const first = await exchangeCode(db, input, T0);
		expect((await verifyApiToken(db, first.accessToken, T0))?.id).toBe(grace.id);

		await expectOAuth(() => exchangeCode(db, input, at(T0, 1000)), 'invalid_grant');

		expect(await verifyApiToken(db, first.accessToken, at(T0, 2000))).toBeNull();
		expect(await credentialValid(db, apiTokenCredential(first.accessToken), at(T0, 2000))).toBe(
			false
		);
		expect(heard).toContainEqual(apiTokenCredential(first.accessToken));
		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: registered.client, refreshToken: first.refreshToken },
					at(T0, 2000)
				),
			'invalid_grant'
		);
		expect((await listApiTokens(db, grace, grace.id))[0].revokedAt).not.toBeNull();
	});

	it('leaves other connections alone when a used code is replayed', async () => {
		const registered = await newClient();
		const bystander = await connect({ client: registered });
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge);
		const input = {
			client: registered.client,
			code: issued,
			redirectUri: URI_A,
			codeVerifier: verifier
		};
		await exchangeCode(db, input, T0);

		await expectOAuth(() => exchangeCode(db, input, at(T0, 1000)), 'invalid_grant');

		expect((await verifyApiToken(db, bystander.tokens.accessToken, at(T0, 2000)))?.id).toBe(
			grace.id
		);
	});
});

describe('refreshGrant', () => {
	it('returns a new token set and marks the old refresh token used', async () => {
		const first = await connect();
		const later = at(T0, 10 * 60 * 1000);

		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			later
		);

		expect(next.accessToken).toMatch(/^wlt_/);
		expect(next.refreshToken).toMatch(/^wlr_/);
		expect(next.accessToken).not.toBe(first.tokens.accessToken);
		expect(next.refreshToken).not.toBe(first.tokens.refreshToken);
		expect(next.expiresIn).toBe(3600);
		expect(next.scope).toBe('sagas');
		const rows = await db.select().from(oauthRefreshTokens);
		const old = rows.find((r) => r.tokenHash === hashSecret(first.tokens.refreshToken))!;
		const fresh = rows.find((r) => r.tokenHash === hashSecret(next.refreshToken))!;
		expect(old.usedAt).toEqual(later);
		expect(fresh.usedAt).toBeNull();
		expect(fresh.expiresAt).toEqual(at(later, REFRESH_TOKEN_TTL_MS));
	});

	it('replaces the access token in place: same row, new secret, new expiry, still not revoked', async () => {
		const first = await connect();
		const [before] = await listApiTokens(db, grace, grace.id);
		const later = at(T0, 50 * 60 * 1000);

		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			later
		);

		const listed = await listApiTokens(db, grace, grace.id);
		expect(listed).toHaveLength(1);
		expect(listed[0].id).toBe(before.id);
		expect(listed[0].revokedAt).toBeNull();
		expect(listed[0].oauth).toBe(true);
		expect(listed[0].expiresAt).toEqual(at(later, ACCESS_TOKEN_TTL_MS));
		const [row] = await db.select().from(apiTokens);
		expect(row.tokenHash).toBe(hashSecret(next.accessToken));
		expect(await grantIdOf(next.accessToken)).toBe(first.grantId);
	});

	it('stops the old access token verifying and starts the new one', async () => {
		const first = await connect();
		const later = at(T0, 30 * 60 * 1000);

		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			later
		);

		expect(await verifyApiToken(db, first.tokens.accessToken, later)).toBeNull();
		expect(await credentialValid(db, apiTokenCredential(first.tokens.accessToken), later)).toBe(
			false
		);
		expect((await verifyApiToken(db, next.accessToken, later))?.id).toBe(grace.id);
		expect(await credentialValid(db, apiTokenCredential(next.accessToken), later)).toBe(true);
	});

	it('announces the old access-token hash once, after the transaction has committed', async () => {
		const first = await connect();
		const seen: Promise<{ credential: Credential; inTransaction: boolean; stillValid: boolean }>[] =
			[];
		const stop = onRevoked((credential) => {
			const inside = inTransaction();
			seen.push(
				credentialValid(db, credential, at(T0, 1000)).then((stillValid) => ({
					credential,
					inTransaction: inside,
					stillValid
				}))
			);
		});
		heard.length = 0;

		await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			at(T0, 1000)
		);
		stop();

		expect(heard).toEqual([{ kind: 'api_token', hash: hashSecret(first.tokens.accessToken) }]);
		expect(await Promise.all(seen)).toEqual([
			{
				credential: { kind: 'api_token', hash: hashSecret(first.tokens.accessToken) },
				inTransaction: false,
				stillValid: false
			}
		]);
	});

	it('announces nothing when the refresh fails', async () => {
		const first = await connect();
		heard.length = 0;

		await expectOAuth(
			() => refreshGrant(db, { client: first.client, refreshToken: 'wlr_unknown' }, at(T0, 1000)),
			'invalid_grant'
		);

		expect(heard).toEqual([]);
		expect((await verifyApiToken(db, first.tokens.accessToken, at(T0, 1000)))?.id).toBe(grace.id);
	});

	it('refreshes after the access token has already expired', async () => {
		const first = await connect();
		const later = at(T0, 2 * HOUR);
		expect(await verifyApiToken(db, first.tokens.accessToken, later)).toBeNull();

		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			later
		);

		expect((await verifyApiToken(db, next.accessToken, later))?.id).toBe(grace.id);
		expect(await verifyApiToken(db, next.accessToken, at(later, ACCESS_TOKEN_TTL_MS))).toBeNull();
		expect(
			(await verifyApiToken(db, next.accessToken, at(later, ACCESS_TOKEN_TTL_MS - 1)))?.id
		).toBe(grace.id);
	});

	it('rotates on every use: each refresh token works once and its successor keeps the chain alive', async () => {
		const first = await connect();
		const second = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			at(T0, HOUR)
		);
		const third = await refreshGrant(
			db,
			{ client: first.client, refreshToken: second.refreshToken },
			at(T0, 2 * HOUR)
		);

		expect((await verifyApiToken(db, third.accessToken, at(T0, 2 * HOUR)))?.id).toBe(grace.id);
		expect(await listApiTokens(db, grace, grace.id)).toHaveLength(1);
	});

	it('accepts a refresh token right up to its 30 day expiry and refuses it after', async () => {
		const first = await connect();
		const second = await connect({ client: { client: first.client, clientSecret: null } });

		const ok = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			at(T0, REFRESH_TOKEN_TTL_MS - 1000)
		);
		expect(ok.accessToken).toMatch(/^wlt_/);
		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: first.client, refreshToken: second.tokens.refreshToken },
					at(T0, REFRESH_TOKEN_TTL_MS + 1000)
				),
			'invalid_grant'
		);
	});

	it('rejects an unknown refresh token', async () => {
		const { client } = await newClient();

		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: 'wlr_unknown' }, T0),
			'invalid_grant'
		);
	});

	it('rejects the refresh token of another client, and does not hand it a token', async () => {
		const first = await connect();
		const other = await newClient('none', 'Other');

		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: other.client, refreshToken: first.tokens.refreshToken },
					at(T0, 1000)
				),
			'invalid_grant'
		);
		expect((await verifyApiToken(db, first.tokens.accessToken, at(T0, 1000)))?.id).toBe(grace.id);
	});

	it('rejects a refresh token whose grant was revoked', async () => {
		const first = await connect();
		await revokeGrant(db, first.grantId, at(T0, 1000));

		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: first.client, refreshToken: first.tokens.refreshToken },
					at(T0, 2000)
				),
			'invalid_grant'
		);
		expect((await db.select().from(apiTokens))[0].revokedAt).not.toBeNull();
	});

	it('treats a rotated refresh token as theft: fails and revokes the whole grant', async () => {
		const first = await connect();
		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			at(T0, 1000)
		);
		heard.length = 0;

		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: first.client, refreshToken: first.tokens.refreshToken },
					at(T0, 2000)
				),
			'invalid_grant'
		);

		expect(await verifyApiToken(db, next.accessToken, at(T0, 2000))).toBeNull();
		expect(await credentialValid(db, apiTokenCredential(next.accessToken), at(T0, 2000))).toBe(
			false
		);
		expect(heard).toContainEqual(apiTokenCredential(next.accessToken));
		await expectOAuth(
			() =>
				refreshGrant(db, { client: first.client, refreshToken: next.refreshToken }, at(T0, 3000)),
			'invalid_grant'
		);
		expect((await listApiTokens(db, grace, grace.id))[0].revokedAt).not.toBeNull();
	});

	it('does not revoke other connections when one refresh token is replayed', async () => {
		const registered = await newClient();
		const bystander = await connect({ client: registered });
		const victim = await connect({ client: registered });
		await refreshGrant(
			db,
			{ client: victim.client, refreshToken: victim.tokens.refreshToken },
			at(T0, 1000)
		);

		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: victim.client, refreshToken: victim.tokens.refreshToken },
					at(T0, 2000)
				),
			'invalid_grant'
		);

		expect((await verifyApiToken(db, bystander.tokens.accessToken, at(T0, 2000)))?.id).toBe(
			grace.id
		);
	});
});

describe('revokeGrant', () => {
	it('kills the access token and the refresh token together', async () => {
		const first = await connect();
		heard.length = 0;

		await revokeGrant(db, first.grantId, at(T0, 1000));

		expect(await verifyApiToken(db, first.tokens.accessToken, at(T0, 1000))).toBeNull();
		expect(
			await credentialValid(db, apiTokenCredential(first.tokens.accessToken), at(T0, 1000))
		).toBe(false);
		expect((await listApiTokens(db, grace, grace.id))[0].revokedAt).toEqual(at(T0, 1000));
		expect(heard).toEqual([apiTokenCredential(first.tokens.accessToken)]);
		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: first.client, refreshToken: first.tokens.refreshToken },
					at(T0, 2000)
				),
			'invalid_grant'
		);
	});

	it('announces after the transaction has committed', async () => {
		const first = await connect();
		const states: boolean[] = [];
		const stop = onRevoked(() => states.push(inTransaction()));

		await revokeGrant(db, first.grantId, at(T0, 1000));
		stop();

		expect(states).toEqual([false]);
	});

	it('is idempotent: a second call changes nothing and does not throw', async () => {
		const first = await connect();
		await revokeGrant(db, first.grantId, at(T0, 1000));
		const before = await listApiTokens(db, grace, grace.id);

		await revokeGrant(db, first.grantId, at(T0, 5000));

		expect(await listApiTokens(db, grace, grace.id)).toEqual(before);
		expect(before[0].revokedAt).toEqual(at(T0, 1000));
		expect(await verifyApiToken(db, first.tokens.accessToken, at(T0, 5000))).toBeNull();
	});

	it('revokes only its own connection', async () => {
		const registered = await newClient();
		const one = await connect({ client: registered });
		const two = await connect({ client: registered });

		await revokeGrant(db, one.grantId, at(T0, 1000));

		expect((await verifyApiToken(db, two.tokens.accessToken, at(T0, 1000)))?.id).toBe(grace.id);
	});
});

describe('revoking an OAuth access token through the API token path', () => {
	it('kills the connection: the refresh token stops working', async () => {
		const first = await connect();
		const [info] = await listApiTokens(db, grace, grace.id);
		heard.length = 0;

		await revokeApiToken(db, grace, info.id);

		expect(await verifyApiToken(db, first.tokens.accessToken, T0)).toBeNull();
		expect(heard).toEqual([apiTokenCredential(first.tokens.accessToken)]);
		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client: first.client, refreshToken: first.tokens.refreshToken },
					at(T0, 1000)
				),
			'invalid_grant'
		);
	});

	it('does not touch another connection of the same User', async () => {
		const registered = await newClient();
		const one = await connect({ client: registered });
		const two = await connect({ client: registered });
		const tokenId = (
			await db
				.select({ id: apiTokens.id })
				.from(apiTokens)
				.where(eq(apiTokens.grantId, one.grantId))
				.limit(1)
		)[0]!.id;

		await revokeApiToken(db, grace, tokenId);

		expect((await verifyApiToken(db, two.tokens.accessToken, T0))?.id).toBe(grace.id);
		expect(
			(
				await refreshGrant(
					db,
					{ client: registered.client, refreshToken: two.tokens.refreshToken },
					T0
				)
			).accessToken
		).toMatch(/^wlt_/);
	});

	it('leaves a hand-made token revoking as before', async () => {
		const { id, token } = await createApiToken(db, grace, grace.id, 'laptop');
		const connection = await connect();

		await revokeApiToken(db, grace, id);

		expect(await verifyApiToken(db, token, T0)).toBeNull();
		expect((await verifyApiToken(db, connection.tokens.accessToken, T0))?.id).toBe(grace.id);
	});
});

describe('API token expiry', () => {
	it('lets a hand-made token verify far in the future', async () => {
		const { token } = await createApiToken(db, grace, grace.id, 'laptop');
		const farFuture = new Date('2126-01-01T00:00:00.000Z');

		expect((await verifyApiToken(db, token, farFuture))?.id).toBe(grace.id);
		expect(await credentialValid(db, apiTokenCredential(token), farFuture)).toBe(true);
	});

	it('lists a hand-made token as never expiring and not OAuth', async () => {
		await createApiToken(db, grace, grace.id, 'laptop');

		const [info] = await listApiTokens(db, grace, grace.id);

		expect(info.expiresAt).toBeNull();
		expect(info.oauth).toBe(false);
	});

	it('lists hand-made and OAuth tokens side by side with their own expiry and flag', async () => {
		const handMade = await createApiToken(db, grace, grace.id, 'laptop');
		await connect({ client: await newClient('none', 'Claude') });

		const listed = await listApiTokens(db, grace, grace.id);

		expect(listed.map((t) => [t.id, t.name, t.oauth, t.expiresAt])).toEqual([
			[handMade.id, 'laptop', false, null],
			[listed[1].id, 'Claude (OAuth)', true, at(T0, ACCESS_TOKEN_TTL_MS)]
		]);
	});

	it('stamps last use on a valid OAuth token but not on an expired one', async () => {
		const { tokens } = await connect();
		const [before] = await db.select().from(apiTokens);

		await verifyApiToken(db, tokens.accessToken, at(T0, 2 * HOUR));

		const [after] = await db.select().from(apiTokens);
		expect(after.lastUsedAt).toEqual(before.lastUsedAt);
	});
});

describe('pruneOAuth', () => {
	it('deletes expired codes and keeps live ones', async () => {
		const { client } = await newClient();
		const expired = await code(client, pkce().challenge, T0);
		const live = await code(client, pkce().challenge, at(T0, 5 * 60 * 1000));

		await pruneOAuth(db, at(T0, AUTHORIZATION_CODE_TTL_MS + 60 * 1000));

		const rows = await db.select().from(oauthCodes);
		expect(rows.map((r) => r.codeHash)).toEqual([hashSecret(live)]);
		expect(rows.map((r) => r.codeHash)).not.toContain(hashSecret(expired));
	});

	it('keeps a used but unexpired code so replay is still detected', async () => {
		const registered = await newClient();
		const { verifier, challenge } = pkce();
		const issued = await code(registered.client, challenge);
		const input = {
			client: registered.client,
			code: issued,
			redirectUri: URI_A,
			codeVerifier: verifier
		};
		const first = await exchangeCode(db, input, T0);

		await pruneOAuth(db, at(T0, 60 * 1000));

		expect(await db.select().from(oauthCodes)).toHaveLength(1);
		await expectOAuth(() => exchangeCode(db, input, at(T0, 2 * 60 * 1000)), 'invalid_grant');
		expect(await verifyApiToken(db, first.accessToken, at(T0, 2 * 60 * 1000))).toBeNull();
	});

	it('keeps a live connection whole: grant, tokens and a usable refresh token', async () => {
		const first = await connect();

		await pruneOAuth(db, at(T0, 2 * HOUR));

		expect(await db.select().from(oauthGrants)).toHaveLength(1);
		expect(await db.select().from(oauthRefreshTokens)).toHaveLength(1);
		expect(await db.select().from(oauthClients)).toHaveLength(1);
		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			at(T0, 2 * HOUR)
		);
		expect((await verifyApiToken(db, next.accessToken, at(T0, 2 * HOUR)))?.id).toBe(grace.id);
	});

	it('keeps a recently rotated refresh token and drops it once used more than a day ago', async () => {
		const first = await connect();
		const rotatedAt = at(T0, HOUR);
		const next = await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			rotatedAt
		);

		await pruneOAuth(db, at(rotatedAt, HOUR));
		expect(await db.select().from(oauthRefreshTokens)).toHaveLength(2);

		await pruneOAuth(db, at(rotatedAt, DAY + HOUR));
		const rows = await db.select().from(oauthRefreshTokens);
		expect(rows.map((r) => r.tokenHash)).toEqual([hashSecret(next.refreshToken)]);
		expect(await db.select().from(oauthGrants)).toHaveLength(1);
	});

	it('deletes a revoked grant with its refresh tokens', async () => {
		const first = await connect();
		const keeper = await connect({ client: { client: first.client, clientSecret: null } });
		await revokeGrant(db, first.grantId, at(T0, 1000));

		await pruneOAuth(db, at(T0, 2000));

		expect((await db.select().from(oauthGrants)).map((g) => g.id)).toEqual([keeper.grantId]);
		expect((await db.select().from(oauthRefreshTokens)).map((r) => r.tokenHash)).toEqual([
			hashSecret(keeper.tokens.refreshToken)
		]);
		expect((await verifyApiToken(db, keeper.tokens.accessToken, at(T0, 2000)))?.id).toBe(grace.id);
	});

	it('deletes a grant whose newest refresh token has expired', async () => {
		const first = await connect();
		const rotatedAt = at(T0, 10 * DAY);
		await refreshGrant(
			db,
			{ client: first.client, refreshToken: first.tokens.refreshToken },
			rotatedAt
		);

		await pruneOAuth(db, at(T0, REFRESH_TOKEN_TTL_MS + DAY));
		expect(await db.select().from(oauthGrants)).toHaveLength(1);

		await pruneOAuth(db, at(rotatedAt, REFRESH_TOKEN_TTL_MS + HOUR));
		expect(await db.select().from(oauthGrants)).toHaveLength(0);
		expect(await db.select().from(oauthRefreshTokens)).toHaveLength(0);
	});

	it('deletes clients older than a day that have no grants, and keeps younger ones', async () => {
		const old = await newClient('none', 'Old', [URI_A], T0);
		const young = await newClient('none', 'Young', [URI_A], at(T0, 23 * HOUR));

		await pruneOAuth(db, at(T0, DAY + 2 * HOUR));

		expect(await getClient(db, old.client.clientId)).toBeNull();
		expect((await getClient(db, young.client.clientId))?.name).toBe('Young');
	});

	it('keeps a client older than a day while it still has a grant', async () => {
		const registered = await newClient('none', 'Claude', [URI_A], T0);
		await connect({ client: registered });

		await pruneOAuth(db, at(T0, 2 * DAY));

		expect((await getClient(db, registered.client.clientId))?.name).toBe('Claude');
	});

	it('leaves hand-made API tokens and their expiry alone', async () => {
		const { token } = await createApiToken(db, grace, grace.id, 'laptop');
		await connect();

		await pruneOAuth(db, at(T0, 60 * DAY));

		expect((await verifyApiToken(db, token, at(T0, 60 * DAY)))?.id).toBe(grace.id);
	});

	it('is harmless on an empty database and when run twice', async () => {
		await pruneOAuth(db, T0);
		const first = await connect();
		await pruneOAuth(db, at(T0, HOUR));
		await pruneOAuth(db, at(T0, HOUR));

		expect((await verifyApiToken(db, first.tokens.accessToken, at(T0, HOUR - 1)))?.id).toBe(
			grace.id
		);
	});
});
