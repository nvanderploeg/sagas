import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	apiTokens,
	oauthClients,
	oauthCodes,
	oauthGrants,
	oauthRefreshTokens,
	users
} from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { apiTokenCredential, credentialValid, onRevoked, type Credential } from './credentials.ts';
import { seedHuman } from './fixtures.ts';
import {
	ACCESS_TOKEN_TTL_MS,
	AUTHORIZATION_CODE_TTL_MS,
	OAUTH_REDIRECT_URIS,
	OAUTH_SCOPE,
	OAuthError,
	REFRESH_TOKEN_TTL_MS,
	authenticateClient,
	exchangeCode,
	getClient,
	issueCode,
	pruneOAuth,
	refreshGrant,
	registerClient,
	revokeGrant,
	type OAuthClient
} from './oauth.ts';
import { hashSecret } from './secrets.ts';
import { createApiToken, revokeApiToken, verifyApiToken } from './tokens.ts';
import type { AuthUser } from './users.ts';

const CALLBACK = OAUTH_REDIRECT_URIS[0];
const T0 = new Date('2026-01-01T00:00:00Z');
const after = (base: Date, ms: number) => new Date(base.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const VERIFIER = 'v'.repeat(43);
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

let db: Db;
let ada: AuthUser;

beforeEach(() => {
	db = testDb();
	ada = seedHuman(db, 'ada');
});

afterEach(() => {
	db.$client.close();
});

function oauthErrorOf(action: () => unknown): OAuthError {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(OAuthError);
	return thrown as OAuthError;
}

const expectOAuth = (action: () => unknown, code: OAuthError['error']) =>
	expect(oauthErrorOf(action).error).toBe(code);

function register(input: Partial<Parameters<typeof registerClient>[1]> = {}, now = T0) {
	return registerClient(db, { redirectUris: [CALLBACK], ...input }, now);
}

function authorize(
	client: OAuthClient,
	opts: { verifier?: string; redirectUri?: string; userId?: number; now?: Date } = {}
) {
	return issueCode(
		db,
		{
			clientId: client.clientId,
			userId: opts.userId ?? ada.id,
			redirectUri: opts.redirectUri ?? CALLBACK,
			codeChallenge: challengeOf(opts.verifier ?? VERIFIER),
			codeChallengeMethod: 'S256'
		},
		opts.now ?? T0
	);
}

function connect(client: OAuthClient, now = T0) {
	const code = authorize(client, { now });
	return exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER }, now);
}

const grantOf = (accessToken: string) =>
	db
		.select({ grantId: apiTokens.grantId })
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, hashSecret(accessToken)))
		.get()!.grantId!;

describe('registerClient', () => {
	it('registers a public client by default and returns no secret', () => {
		const { client, clientSecret } = register({ name: '  Claude  ' });

		expect(client.clientId).toMatch(/^wlc_/);
		expect(client.name).toBe('Claude');
		expect(client.authMethod).toBe('none');
		expect(client.redirectUris).toEqual([CALLBACK]);
		expect(clientSecret).toBeNull();
		expect(getClient(db, client.clientId)).toEqual(client);
	});

	it('defaults a missing or blank name', () => {
		expect(register().client.name).toBe('OAuth client');
		expect(register({ name: '   ' }).client.name).toBe('OAuth client');
	});

	it('returns a confidential client secret once and stores only its hash', () => {
		for (const authMethod of ['client_secret_post', 'client_secret_basic'] as const) {
			const { client, clientSecret } = register({ authMethod });

			expect(clientSecret).toMatch(/^wlk_/);
			const row = db.select().from(oauthClients).where(eq(oauthClients.id, client.clientId)).get()!;
			expect(row.secretHash).toBe(hashSecret(clientSecret!));
			expect(JSON.stringify(row)).not.toContain(clientSecret!);
		}
	});

	it('accepts several registered redirect URIs', () => {
		const { client } = register({ redirectUris: [...OAUTH_REDIRECT_URIS] });
		expect(client.redirectUris).toEqual([...OAUTH_REDIRECT_URIS]);
	});

	it('rejects redirect URIs that are missing, empty, malformed or unregistered', () => {
		for (const redirectUris of [
			undefined,
			null,
			[],
			CALLBACK,
			[42],
			['https://evil.example/cb'],
			[CALLBACK, 'https://evil.example/cb'],
			[CALLBACK + '/']
		]) {
			expectOAuth(() => register({ redirectUris }), 'invalid_redirect_uri');
		}
	});

	it('rejects a name that is not a string or longer than 100 characters', () => {
		expectOAuth(() => register({ name: 7 }), 'invalid_client_metadata');
		expectOAuth(() => register({ name: null }), 'invalid_client_metadata');
		expectOAuth(() => register({ name: 'x'.repeat(101) }), 'invalid_client_metadata');
		expect(register({ name: 'x'.repeat(100) }).client.name).toHaveLength(100);
	});

	it('rejects an unknown authentication method', () => {
		expectOAuth(() => register({ authMethod: 'private_key_jwt' }), 'invalid_client_metadata');
		expectOAuth(() => register({ authMethod: 5 }), 'invalid_client_metadata');
		expectOAuth(() => register({ authMethod: null }), 'invalid_client_metadata');
	});

	it('stores nothing when validation fails', () => {
		expectOAuth(() => register({ redirectUris: [] }), 'invalid_redirect_uri');
		expect(db.select().from(oauthClients).all()).toEqual([]);
	});
});

describe('client lookup and authentication', () => {
	it('finds no client for an unknown id', () => {
		expect(getClient(db, 'wlc_nope')).toBeNull();
		expectOAuth(() => authenticateClient(db, 'wlc_nope', null), 'invalid_client');
	});

	it('authenticates a public client and ignores a secret it was never given', () => {
		const { client } = register();

		expect(authenticateClient(db, client.clientId, null)).toEqual(client);
		expect(authenticateClient(db, client.clientId, 'anything')).toEqual(client);
	});

	it('authenticates a confidential client only with its own secret', () => {
		for (const authMethod of ['client_secret_post', 'client_secret_basic'] as const) {
			const { client, clientSecret } = register({ authMethod });

			expect(authenticateClient(db, client.clientId, clientSecret)).toEqual(client);
			expectOAuth(() => authenticateClient(db, client.clientId, null), 'invalid_client');
			expectOAuth(() => authenticateClient(db, client.clientId, 'wlk_wrong'), 'invalid_client');
			expectOAuth(() => authenticateClient(db, client.clientId, ''), 'invalid_client');
		}
	});

	it('rejects the secret of another client', () => {
		const first = register({ authMethod: 'client_secret_post' });
		const second = register({ authMethod: 'client_secret_post' });

		expectOAuth(
			() => authenticateClient(db, first.client.clientId, second.clientSecret),
			'invalid_client'
		);
	});
});

describe('issueCode', () => {
	const issue = (client: OAuthClient, overrides: Partial<Parameters<typeof issueCode>[1]> = {}) =>
		issueCode(
			db,
			{
				clientId: client.clientId,
				userId: ada.id,
				redirectUri: CALLBACK,
				codeChallenge: challengeOf(VERIFIER),
				codeChallengeMethod: 'S256',
				...overrides
			},
			T0
		);

	it('returns a code stored only as its hash, expiring after the code TTL', () => {
		const { client } = register();

		const code = issue(client);

		expect(code).toMatch(/^wla_/);
		const row = db.select().from(oauthCodes).all()[0];
		expect(row.codeHash).toBe(hashSecret(code));
		expect(JSON.stringify(row)).not.toContain(code);
		expect(row.userId).toBe(ada.id);
		expect(row.expiresAt).toEqual(after(T0, AUTHORIZATION_CODE_TTL_MS));
		expect(row.usedAt).toBeNull();
	});

	it('rejects an unknown client', () => {
		expectOAuth(() => issue({ clientId: 'wlc_nope' } as OAuthClient), 'invalid_client');
	});

	it('rejects a redirect URI the client did not register', () => {
		const { client } = register({ redirectUris: [OAUTH_REDIRECT_URIS[0]] });

		expectOAuth(
			() => issue(client, { redirectUri: OAUTH_REDIRECT_URIS[1] }),
			'invalid_redirect_uri'
		);
		expectOAuth(() => issue(client, { redirectUri: CALLBACK + '/' }), 'invalid_redirect_uri');
	});

	it('requires S256 and a 43-character base64url challenge', () => {
		const { client } = register();

		expectOAuth(() => issue(client, { codeChallengeMethod: 'plain' }), 'invalid_request');
		expectOAuth(() => issue(client, { codeChallengeMethod: 's256' }), 'invalid_request');
		expectOAuth(() => issue(client, { codeChallenge: 'short' }), 'invalid_request');
		expectOAuth(() => issue(client, { codeChallenge: 'a'.repeat(44) }), 'invalid_request');
		expectOAuth(() => issue(client, { codeChallenge: '+'.repeat(43) }), 'invalid_request');
		expect(db.select().from(oauthCodes).all()).toEqual([]);
	});
});

describe('exchangeCode', () => {
	it('issues an expiring access token that acts as the consenting User', () => {
		const { client } = register({ name: 'Claude' });
		const code = authorize(client);

		const tokens = exchangeCode(
			db,
			{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
			T0
		);

		expect(tokens.accessToken).toMatch(/^wlt_/);
		expect(tokens.refreshToken).toMatch(/^wlr_/);
		expect(tokens.expiresIn).toBe(3600);
		expect(tokens.scope).toBe(OAUTH_SCOPE);

		expect(verifyApiToken(db, tokens.accessToken, T0)?.id).toBe(ada.id);
		expect(verifyApiToken(db, tokens.accessToken, after(T0, ACCESS_TOKEN_TTL_MS - 1))?.id).toBe(
			ada.id
		);
		expect(verifyApiToken(db, tokens.accessToken, after(T0, ACCESS_TOKEN_TTL_MS))).toBeNull();

		const row = db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.tokenHash, hashSecret(tokens.accessToken)))
			.get()!;
		expect(row.name).toBe('Claude (OAuth)');
		expect(row.expiresAt).toEqual(after(T0, ACCESS_TOKEN_TTL_MS));
		expect(row.grantId).not.toBeNull();

		const refresh = db.select().from(oauthRefreshTokens).all();
		expect(refresh).toHaveLength(1);
		expect(refresh[0].tokenHash).toBe(hashSecret(tokens.refreshToken));
		expect(refresh[0].expiresAt).toEqual(after(T0, REFRESH_TOKEN_TTL_MS));
		expect(refresh[0].grantId).toBe(row.grantId);

		const grant = db.select().from(oauthGrants).all()[0];
		expect(grant).toMatchObject({ id: row.grantId, clientId: client.clientId, userId: ada.id });
		expect(grant.revokedAt).toBeNull();
	});

	it('is accepted by the credential check until the access token expires', () => {
		const { client } = register();
		const { accessToken } = connect(client);
		const credential = apiTokenCredential(accessToken);

		expect(credentialValid(db, credential, after(T0, HOUR - 1))).toBe(true);
		expect(credentialValid(db, credential, after(T0, HOUR))).toBe(false);
	});

	it('rejects an unknown code', () => {
		const { client } = register();
		expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code: 'wla_unknown', redirectUri: CALLBACK, codeVerifier: VERIFIER },
					T0
				),
			'invalid_grant'
		);
	});

	it('rejects an expired code', () => {
		const { client } = register();
		const code = authorize(client);

		expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					after(T0, AUTHORIZATION_CODE_TTL_MS)
				),
			'invalid_grant'
		);
		expect(db.select().from(oauthGrants).all()).toEqual([]);
	});

	it('rejects a code issued to another client without spending it', () => {
		const owner = register().client;
		const other = register().client;
		const code = authorize(owner);

		expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client: other, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					T0
				),
			'invalid_grant'
		);
		expect(
			exchangeCode(db, { client: owner, code, redirectUri: CALLBACK, codeVerifier: VERIFIER }, T0)
				.accessToken
		).toMatch(/^wlt_/);
	});

	it('rejects a different redirect URI', () => {
		const { client } = register({ redirectUris: [...OAUTH_REDIRECT_URIS] });
		const code = authorize(client);

		expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code, redirectUri: OAUTH_REDIRECT_URIS[1], codeVerifier: VERIFIER },
					T0
				),
			'invalid_grant'
		);
	});

	it('rejects a verifier that does not match the challenge', () => {
		const { client } = register();
		const code = authorize(client);

		expectOAuth(
			() =>
				exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: 'w'.repeat(43) }, T0),
			'invalid_grant'
		);
		expect(db.select().from(oauthGrants).all()).toEqual([]);
	});

	it('rejects a malformed verifier as an invalid request', () => {
		const { client } = register();
		const code = authorize(client);

		for (const codeVerifier of [
			'',
			'short',
			'v'.repeat(42),
			'v'.repeat(129),
			'v'.repeat(42) + '!'
		]) {
			expectOAuth(
				() => exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier }, T0),
				'invalid_request'
			);
		}
	});

	it('accepts the longest verifier the spec allows', () => {
		const { client } = register();
		const verifier = 'a-._~'.repeat(25) + 'abc';
		const code = authorize(client, { verifier });

		expect(
			exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: verifier }, T0)
				.accessToken
		).toMatch(/^wlt_/);
	});

	it('revokes the grant when a used code is presented again', () => {
		const { client } = register();
		const code = authorize(client);
		const first = exchangeCode(
			db,
			{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
			T0
		);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					after(T0, 1000)
				),
			'invalid_grant'
		);
		stop();

		expect(verifyApiToken(db, first.accessToken, after(T0, 1000))).toBeNull();
		expectOAuth(
			() => refreshGrant(db, { client, refreshToken: first.refreshToken }),
			'invalid_grant'
		);
		expect(db.select().from(oauthGrants).all()[0].revokedAt).not.toBeNull();
		expect(ended).toEqual([apiTokenCredential(first.accessToken)]);
	});

	it('records the grant on the code and spends it', () => {
		const { client } = register();
		const code = authorize(client);
		exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER }, T0);

		const row = db.select().from(oauthCodes).all()[0];
		expect(row.usedAt).toEqual(T0);
		expect(row.grantId).toBe(db.select().from(oauthGrants).all()[0].id);
	});
});

describe('refreshGrant', () => {
	it('hands back the new tokens even when a revocation listener throws', () => {
		const { client } = register();
		const first = connect(client);
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const stop = onRevoked(() => {
			throw new Error('listener broke');
		});

		const second = refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR));
		stop();
		expect(quiet).toHaveBeenCalled();
		quiet.mockRestore();

		expect(verifyApiToken(db, second.accessToken, after(T0, HOUR))?.id).toBe(ada.id);
	});

	it('rotates the refresh token and replaces the access token in place', () => {
		const { client } = register();
		const first = connect(client);
		const rowId = db.select().from(apiTokens).all()[0].id;
		const later = after(T0, HOUR);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		const second = refreshGrant(db, { client, refreshToken: first.refreshToken }, later);
		stop();

		expect(second.accessToken).not.toBe(first.accessToken);
		expect(second.refreshToken).not.toBe(first.refreshToken);
		expect(second.expiresIn).toBe(3600);
		expect(second.scope).toBe(OAUTH_SCOPE);
		expect(verifyApiToken(db, first.accessToken, later)).toBeNull();
		expect(verifyApiToken(db, second.accessToken, later)?.id).toBe(ada.id);
		expect(verifyApiToken(db, second.accessToken, after(later, HOUR))).toBeNull();

		const rows = db.select().from(apiTokens).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(rowId);
		expect(rows[0].revokedAt).toBeNull();
		expect(rows[0].expiresAt).toEqual(after(later, ACCESS_TOKEN_TTL_MS));
		expect(ended).toEqual([apiTokenCredential(first.accessToken)]);

		const stored = db.select().from(oauthRefreshTokens).all();
		expect(stored).toHaveLength(2);
		const old = stored.find((r) => r.tokenHash === hashSecret(first.refreshToken))!;
		expect(old.usedAt).toEqual(later);
		const fresh = stored.find((r) => r.tokenHash === hashSecret(second.refreshToken))!;
		expect(fresh.usedAt).toBeNull();
		expect(fresh.expiresAt).toEqual(after(later, REFRESH_TOKEN_TTL_MS));
	});

	it('keeps rotating along a chain of refreshes', () => {
		const { client } = register();
		let tokens = connect(client);
		for (let i = 1; i <= 3; i++) {
			tokens = refreshGrant(db, { client, refreshToken: tokens.refreshToken }, after(T0, i * HOUR));
		}

		expect(verifyApiToken(db, tokens.accessToken, after(T0, 3 * HOUR))?.id).toBe(ada.id);
	});

	it('revokes the grant when a rotated refresh token is presented again', () => {
		const { client } = register();
		const first = connect(client);
		const second = refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR));
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		expectOAuth(
			() => refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, 2 * HOUR)),
			'invalid_grant'
		);
		stop();

		expect(verifyApiToken(db, second.accessToken, after(T0, 2 * HOUR))).toBeNull();
		expectOAuth(
			() => refreshGrant(db, { client, refreshToken: second.refreshToken }, after(T0, 2 * HOUR)),
			'invalid_grant'
		);
		expect(ended).toEqual([apiTokenCredential(second.accessToken)]);
	});

	it('rejects an unknown refresh token', () => {
		const { client } = register();
		expectOAuth(() => refreshGrant(db, { client, refreshToken: 'wlr_unknown' }), 'invalid_grant');
	});

	it('rejects an expired refresh token', () => {
		const { client } = register();
		const tokens = connect(client);

		expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client, refreshToken: tokens.refreshToken },
					after(T0, REFRESH_TOKEN_TTL_MS)
				),
			'invalid_grant'
		);
		expect(
			refreshGrant(
				db,
				{ client, refreshToken: tokens.refreshToken },
				after(T0, REFRESH_TOKEN_TTL_MS - 1)
			).accessToken
		).toMatch(/^wlt_/);
	});

	it('rejects a refresh token of another client without touching the grant', () => {
		const { client } = register();
		const other = register().client;
		const tokens = connect(client);

		expectOAuth(
			() => refreshGrant(db, { client: other, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
		expect(verifyApiToken(db, tokens.accessToken, T0)?.id).toBe(ada.id);
		expect(refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0).accessToken).toMatch(
			/^wlt_/
		);
	});

	it('rejects the refresh token of a revoked grant', () => {
		const { client } = register();
		const tokens = connect(client);
		revokeGrant(db, grantOf(tokens.accessToken), T0);

		expectOAuth(
			() => refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
	});
});

describe('revoking a connection', () => {
	it('kills the access token and the refresh token together', () => {
		const { client } = register();
		const tokens = connect(client);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		revokeGrant(db, grantOf(tokens.accessToken), T0);
		stop();

		expect(verifyApiToken(db, tokens.accessToken, T0)).toBeNull();
		expect(credentialValid(db, apiTokenCredential(tokens.accessToken), T0)).toBe(false);
		expectOAuth(
			() => refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
		expect(ended).toEqual([apiTokenCredential(tokens.accessToken)]);
	});

	it('is idempotent and announces once', () => {
		const { client } = register();
		const tokens = connect(client);
		const grantId = grantOf(tokens.accessToken);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		revokeGrant(db, grantId, T0);
		const revokedAt = db.select().from(oauthGrants).all()[0].revokedAt;
		revokeGrant(db, grantId, after(T0, HOUR));
		revokeGrant(db, 9999, T0);
		stop();

		expect(ended).toHaveLength(1);
		expect(db.select().from(oauthGrants).all()[0].revokedAt).toEqual(revokedAt);
	});

	it('leaves other connections of the same User alone', () => {
		const { client } = register();
		const first = connect(client);
		const second = connect(client);

		revokeGrant(db, grantOf(first.accessToken), T0);

		expect(verifyApiToken(db, second.accessToken, T0)?.id).toBe(ada.id);
	});

	it('is what revoking the access token as an API token does', () => {
		const { client } = register();
		const tokens = connect(client);
		const tokenId = db.select().from(apiTokens).all()[0].id;
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		revokeApiToken(db, ada, tokenId);
		revokeApiToken(db, ada, tokenId);
		stop();

		expect(verifyApiToken(db, tokens.accessToken, T0)).toBeNull();
		expectOAuth(
			() => refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
		expect(db.select().from(oauthGrants).all()[0].revokedAt).not.toBeNull();
		expect(ended).toEqual([apiTokenCredential(tokens.accessToken)]);
	});

	it('is stopped for the User of another connection', () => {
		const { client } = register();
		connect(client);
		const grace = seedHuman(db, 'grace');
		const tokenId = db.select().from(apiTokens).all()[0].id;

		expect(() => revokeApiToken(db, grace, tokenId)).toThrow();
		expect(db.select().from(oauthGrants).all()[0].revokedAt).toBeNull();
	});
});

describe('hand-made tokens', () => {
	it('never expire and have no connection', () => {
		const { token } = createApiToken(db, ada, ada.id, 'laptop');
		const row = db.select().from(apiTokens).all()[0];

		expect(row.expiresAt).toBeNull();
		expect(row.grantId).toBeNull();
		expect(verifyApiToken(db, token, after(T0, 1000 * DAY))?.id).toBe(ada.id);
		expect(credentialValid(db, apiTokenCredential(token), after(T0, 1000 * DAY))).toBe(true);
	});
});

describe('pruneOAuth', () => {
	const counts = () => ({
		clients: db.select().from(oauthClients).all().length,
		codes: db.select().from(oauthCodes).all().length,
		grants: db.select().from(oauthGrants).all().length,
		refresh: db.select().from(oauthRefreshTokens).all().length,
		access: db.select().from(apiTokens).all().length
	});

	it('keeps live rows', () => {
		const { client } = register();
		connect(client);
		authorize(client);

		pruneOAuth(db, after(T0, 60 * 1000));

		expect(counts()).toEqual({ clients: 1, codes: 2, grants: 1, refresh: 1, access: 1 });
	});

	it('deletes expired codes only', () => {
		const { client } = register();
		authorize(client, { now: T0 });
		authorize(client, { now: after(T0, HOUR) });
		const connected = connect(client, after(T0, 2 * HOUR));

		pruneOAuth(db, after(T0, HOUR + AUTHORIZATION_CODE_TTL_MS - 1));

		expect(counts().codes).toBe(2);
		pruneOAuth(db, after(T0, 2 * HOUR + 1));
		expect(counts().codes).toBe(1);
		pruneOAuth(db, after(T0, 2 * HOUR + AUTHORIZATION_CODE_TTL_MS));
		expect(counts().codes).toBe(0);
		expect(verifyApiToken(db, connected.accessToken, after(T0, 2 * HOUR + 1))?.id).toBe(ada.id);
	});

	it('deletes revoked grants with their tokens, keeping the client', () => {
		const { client } = register();
		const kept = connect(client);
		const revoked = connect(client);
		revokeGrant(db, grantOf(revoked.accessToken), T0);

		pruneOAuth(db, after(T0, HOUR));

		expect(counts()).toMatchObject({ grants: 1, refresh: 1, access: 1 });
		expect(verifyApiToken(db, kept.accessToken, after(T0, HOUR - 1))?.id).toBe(ada.id);
	});

	it('deletes a grant whose newest refresh token expired', () => {
		const { client } = register();
		const first = connect(client);
		refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, DAY));

		pruneOAuth(db, after(T0, REFRESH_TOKEN_TTL_MS));
		expect(counts()).toMatchObject({ grants: 1, refresh: 1 });

		pruneOAuth(db, after(T0, DAY + REFRESH_TOKEN_TTL_MS));
		expect(counts()).toMatchObject({ grants: 0, refresh: 0, access: 0 });
	});

	it('deletes refresh tokens rotated more than a day ago, keeping recent ones for reuse detection', () => {
		const { client } = register();
		const first = connect(client);
		refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR));

		pruneOAuth(db, after(T0, HOUR + DAY));
		expect(counts().refresh).toBe(2);

		pruneOAuth(db, after(T0, HOUR + DAY + 1));
		expect(counts().refresh).toBe(1);
		expectOAuth(
			() =>
				refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR + DAY + 1)),
			'invalid_grant'
		);
		expect(counts().grants).toBe(1);
	});

	it('deletes clients older than a day that have no grants', () => {
		const old = register({}, T0).client;
		const fresh = register({}, after(T0, DAY)).client;
		const connectedOld = register({}, T0).client;
		connect(connectedOld, after(T0, HOUR));
		authorize(old, { now: T0 });

		pruneOAuth(db, after(T0, DAY + HOUR));

		expect(getClient(db, old.clientId)).toBeNull();
		expect(getClient(db, fresh.clientId)).not.toBeNull();
		expect(getClient(db, connectedOld.clientId)).not.toBeNull();
		expect(counts().codes).toBe(0);
	});

	it('keeps a client that once connected after its grants are gone, so its cached client_id still works', () => {
		const { client } = register({}, T0);
		const connected = connect(client, T0);
		revokeGrant(db, grantOf(connected.accessToken), after(T0, HOUR));

		pruneOAuth(db, after(T0, 2 * DAY));

		expect(counts().grants).toBe(0);
		expect(getClient(db, client.clientId)).not.toBeNull();
	});

	it('removes a grant together with its tokens', () => {
		const { client } = register();
		connect(client);

		db.delete(oauthGrants).run();

		expect(counts()).toMatchObject({ grants: 0, refresh: 0, access: 0 });
		expect(getClient(db, client.clientId)).not.toBeNull();
	});

	it('removes a User’s connections when the User is deleted', () => {
		const { client } = register();
		connect(client);

		db.delete(users).where(eq(users.id, ada.id)).run();

		expect(counts()).toMatchObject({ grants: 0, refresh: 0, access: 0, codes: 0 });
	});
});
