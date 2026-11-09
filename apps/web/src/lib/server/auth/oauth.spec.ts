import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(async () => {
	db = await testDb();
	ada = await seedHuman(db, 'ada');
});

async function oauthErrorOf(action: () => unknown): Promise<OAuthError> {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(OAuthError);
	return thrown as OAuthError;
}

const expectOAuth = async (action: () => unknown, code: OAuthError['error']) =>
	expect((await oauthErrorOf(action)).error).toBe(code);

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

async function connect(client: OAuthClient, now = T0) {
	const code = await authorize(client, { now });
	return exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER }, now);
}

const grantOf = async (accessToken: string) =>
	(
		await db
			.select({ grantId: apiTokens.grantId })
			.from(apiTokens)
			.where(eq(apiTokens.tokenHash, hashSecret(accessToken)))
			.limit(1)
	)[0]!.grantId!;

describe('registerClient', () => {
	it('registers a public client by default and returns no secret', async () => {
		const { client, clientSecret } = await register({ name: '  Claude  ' });

		expect(client.clientId).toMatch(/^wlc_/);
		expect(client.name).toBe('Claude');
		expect(client.authMethod).toBe('none');
		expect(client.redirectUris).toEqual([CALLBACK]);
		expect(clientSecret).toBeNull();
		expect(await getClient(db, client.clientId)).toEqual(client);
	});

	it('defaults a missing or blank name', async () => {
		expect((await register()).client.name).toBe('OAuth client');
		expect((await register({ name: '   ' })).client.name).toBe('OAuth client');
	});

	it('returns a confidential client secret once and stores only its hash', async () => {
		for (const authMethod of ['client_secret_post', 'client_secret_basic'] as const) {
			const { client, clientSecret } = await register({ authMethod });

			expect(clientSecret).toMatch(/^wlk_/);
			const row = (
				await db.select().from(oauthClients).where(eq(oauthClients.id, client.clientId)).limit(1)
			)[0]!;
			expect(row.secretHash).toBe(hashSecret(clientSecret!));
			expect(JSON.stringify(row)).not.toContain(clientSecret!);
		}
	});

	it('accepts several registered redirect URIs', async () => {
		const { client } = await register({ redirectUris: [...OAUTH_REDIRECT_URIS] });
		expect(client.redirectUris).toEqual([...OAUTH_REDIRECT_URIS]);
	});

	it('rejects redirect URIs that are missing, empty, malformed or unregistered', async () => {
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
			await expectOAuth(() => register({ redirectUris }), 'invalid_redirect_uri');
		}
	});

	it('rejects a name that is not a string or longer than 100 characters', async () => {
		await expectOAuth(() => register({ name: 7 }), 'invalid_client_metadata');
		await expectOAuth(() => register({ name: null }), 'invalid_client_metadata');
		await expectOAuth(() => register({ name: 'x'.repeat(101) }), 'invalid_client_metadata');
		expect((await register({ name: 'x'.repeat(100) })).client.name).toHaveLength(100);
	});

	it('rejects an unknown authentication method', async () => {
		await expectOAuth(() => register({ authMethod: 'private_key_jwt' }), 'invalid_client_metadata');
		await expectOAuth(() => register({ authMethod: 5 }), 'invalid_client_metadata');
		await expectOAuth(() => register({ authMethod: null }), 'invalid_client_metadata');
	});

	it('stores nothing when validation fails', async () => {
		await expectOAuth(() => register({ redirectUris: [] }), 'invalid_redirect_uri');
		expect(await db.select().from(oauthClients)).toEqual([]);
	});
});

describe('client lookup and authentication', () => {
	it('finds no client for an unknown id', async () => {
		expect(await getClient(db, 'wlc_nope')).toBeNull();
		await expectOAuth(() => authenticateClient(db, 'wlc_nope', null), 'invalid_client');
	});

	it('authenticates a public client and ignores a secret it was never given', async () => {
		const { client } = await register();

		expect(await authenticateClient(db, client.clientId, null)).toEqual(client);
		expect(await authenticateClient(db, client.clientId, 'anything')).toEqual(client);
	});

	it('authenticates a confidential client only with its own secret', async () => {
		for (const authMethod of ['client_secret_post', 'client_secret_basic'] as const) {
			const { client, clientSecret } = await register({ authMethod });

			expect(await authenticateClient(db, client.clientId, clientSecret)).toEqual(client);
			await expectOAuth(() => authenticateClient(db, client.clientId, null), 'invalid_client');
			await expectOAuth(
				() => authenticateClient(db, client.clientId, 'wlk_wrong'),
				'invalid_client'
			);
			await expectOAuth(() => authenticateClient(db, client.clientId, ''), 'invalid_client');
		}
	});

	it('rejects the secret of another client', async () => {
		const first = await register({ authMethod: 'client_secret_post' });
		const second = await register({ authMethod: 'client_secret_post' });

		await expectOAuth(
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

	it('returns a code stored only as its hash, expiring after the code TTL', async () => {
		const { client } = await register();

		const code = await issue(client);

		expect(code).toMatch(/^wla_/);
		const row = (await db.select().from(oauthCodes))[0];
		expect(row.codeHash).toBe(hashSecret(code));
		expect(JSON.stringify(row)).not.toContain(code);
		expect(row.userId).toBe(ada.id);
		expect(row.expiresAt).toEqual(after(T0, AUTHORIZATION_CODE_TTL_MS));
		expect(row.usedAt).toBeNull();
	});

	it('rejects an unknown client', async () => {
		await expectOAuth(() => issue({ clientId: 'wlc_nope' } as OAuthClient), 'invalid_client');
	});

	it('rejects a redirect URI the client did not register', async () => {
		const { client } = await register({ redirectUris: [OAUTH_REDIRECT_URIS[0]] });

		await expectOAuth(
			() => issue(client, { redirectUri: OAUTH_REDIRECT_URIS[1] }),
			'invalid_redirect_uri'
		);
		await expectOAuth(() => issue(client, { redirectUri: CALLBACK + '/' }), 'invalid_redirect_uri');
	});

	it('requires S256 and a 43-character base64url challenge', async () => {
		const { client } = await register();

		await expectOAuth(() => issue(client, { codeChallengeMethod: 'plain' }), 'invalid_request');
		await expectOAuth(() => issue(client, { codeChallengeMethod: 's256' }), 'invalid_request');
		await expectOAuth(() => issue(client, { codeChallenge: 'short' }), 'invalid_request');
		await expectOAuth(() => issue(client, { codeChallenge: 'a'.repeat(44) }), 'invalid_request');
		await expectOAuth(() => issue(client, { codeChallenge: '+'.repeat(43) }), 'invalid_request');
		expect(await db.select().from(oauthCodes)).toEqual([]);
	});
});

describe('exchangeCode', () => {
	it('issues an expiring access token that acts as the consenting User', async () => {
		const { client } = await register({ name: 'Claude' });
		const code = await authorize(client);

		const tokens = await exchangeCode(
			db,
			{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
			T0
		);

		expect(tokens.accessToken).toMatch(/^wlt_/);
		expect(tokens.refreshToken).toMatch(/^wlr_/);
		expect(tokens.expiresIn).toBe(3600);
		expect(tokens.scope).toBe(OAUTH_SCOPE);

		expect((await verifyApiToken(db, tokens.accessToken, T0))?.id).toBe(ada.id);
		expect(
			(await verifyApiToken(db, tokens.accessToken, after(T0, ACCESS_TOKEN_TTL_MS - 1)))?.id
		).toBe(ada.id);
		expect(await verifyApiToken(db, tokens.accessToken, after(T0, ACCESS_TOKEN_TTL_MS))).toBeNull();

		const row = (
			await db
				.select()
				.from(apiTokens)
				.where(eq(apiTokens.tokenHash, hashSecret(tokens.accessToken)))
				.limit(1)
		)[0]!;
		expect(row.name).toBe('Claude (OAuth)');
		expect(row.expiresAt).toEqual(after(T0, ACCESS_TOKEN_TTL_MS));
		expect(row.grantId).not.toBeNull();

		const refresh = await db.select().from(oauthRefreshTokens);
		expect(refresh).toHaveLength(1);
		expect(refresh[0].tokenHash).toBe(hashSecret(tokens.refreshToken));
		expect(refresh[0].expiresAt).toEqual(after(T0, REFRESH_TOKEN_TTL_MS));
		expect(refresh[0].grantId).toBe(row.grantId);

		const grant = (await db.select().from(oauthGrants))[0];
		expect(grant).toMatchObject({ id: row.grantId, clientId: client.clientId, userId: ada.id });
		expect(grant.revokedAt).toBeNull();
	});

	it('is accepted by the credential check until the access token expires', async () => {
		const { client } = await register();
		const { accessToken } = await connect(client);
		const credential = apiTokenCredential(accessToken);

		expect(await credentialValid(db, credential, after(T0, HOUR - 1))).toBe(true);
		expect(await credentialValid(db, credential, after(T0, HOUR))).toBe(false);
	});

	it('rejects an unknown code', async () => {
		const { client } = await register();
		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code: 'wla_unknown', redirectUri: CALLBACK, codeVerifier: VERIFIER },
					T0
				),
			'invalid_grant'
		);
	});

	it('rejects an expired code', async () => {
		const { client } = await register();
		const code = await authorize(client);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					after(T0, AUTHORIZATION_CODE_TTL_MS)
				),
			'invalid_grant'
		);
		expect(await db.select().from(oauthGrants)).toEqual([]);
	});

	it('rejects a code issued to another client without spending it', async () => {
		const owner = (await register()).client;
		const other = (await register()).client;
		const code = await authorize(owner);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client: other, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					T0
				),
			'invalid_grant'
		);
		expect(
			(
				await exchangeCode(
					db,
					{ client: owner, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					T0
				)
			).accessToken
		).toMatch(/^wlt_/);
	});

	it('rejects a different redirect URI', async () => {
		const { client } = await register({ redirectUris: [...OAUTH_REDIRECT_URIS] });
		const code = await authorize(client);

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code, redirectUri: OAUTH_REDIRECT_URIS[1], codeVerifier: VERIFIER },
					T0
				),
			'invalid_grant'
		);
	});

	it('rejects a verifier that does not match the challenge', async () => {
		const { client } = await register();
		const code = await authorize(client);

		await expectOAuth(
			() =>
				exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: 'w'.repeat(43) }, T0),
			'invalid_grant'
		);
		expect(await db.select().from(oauthGrants)).toEqual([]);
	});

	it('rejects a malformed verifier as an invalid request', async () => {
		const { client } = await register();
		const code = await authorize(client);

		for (const codeVerifier of [
			'',
			'short',
			'v'.repeat(42),
			'v'.repeat(129),
			'v'.repeat(42) + '!'
		]) {
			await expectOAuth(
				() => exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier }, T0),
				'invalid_request'
			);
		}
	});

	it('accepts the longest verifier the spec allows', async () => {
		const { client } = await register();
		const verifier = 'a-._~'.repeat(25) + 'abc';
		const code = await authorize(client, { verifier });

		expect(
			(await exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: verifier }, T0))
				.accessToken
		).toMatch(/^wlt_/);
	});

	it('revokes the grant when a used code is presented again', async () => {
		const { client } = await register();
		const code = await authorize(client);
		const first = await exchangeCode(
			db,
			{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
			T0
		);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		await expectOAuth(
			() =>
				exchangeCode(
					db,
					{ client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER },
					after(T0, 1000)
				),
			'invalid_grant'
		);
		stop();

		expect(await verifyApiToken(db, first.accessToken, after(T0, 1000))).toBeNull();
		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: first.refreshToken }),
			'invalid_grant'
		);
		expect((await db.select().from(oauthGrants))[0].revokedAt).not.toBeNull();
		expect(ended).toEqual([apiTokenCredential(first.accessToken)]);
	});

	it('records the grant on the code and spends it', async () => {
		const { client } = await register();
		const code = await authorize(client);
		await exchangeCode(db, { client, code, redirectUri: CALLBACK, codeVerifier: VERIFIER }, T0);

		const row = (await db.select().from(oauthCodes))[0];
		expect(row.usedAt).toEqual(T0);
		expect(row.grantId).toBe((await db.select().from(oauthGrants))[0].id);
	});
});

describe('refreshGrant', () => {
	it('refuses a banned User and leaves the token row alone', async () => {
		const { client } = await register();
		const first = await connect(client);
		const before = (await db.select().from(apiTokens))[0];
		await db.update(users).set({ bannedAt: T0 }).where(eq(users.id, ada.id));

		const error = await oauthErrorOf(() =>
			refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR))
		);

		expect(error.error).toBe('invalid_grant');
		expect((await db.select().from(apiTokens))[0].tokenHash).toBe(before.tokenHash);
	});

	it('hands back the new tokens even when a revocation listener throws', async () => {
		const { client } = await register();
		const first = await connect(client);
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const stop = onRevoked(() => {
			throw new Error('listener broke');
		});

		const second = await refreshGrant(
			db,
			{ client, refreshToken: first.refreshToken },
			after(T0, HOUR)
		);
		stop();
		expect(quiet).toHaveBeenCalled();
		quiet.mockRestore();

		expect((await verifyApiToken(db, second.accessToken, after(T0, HOUR)))?.id).toBe(ada.id);
	});

	it('rotates the refresh token and replaces the access token in place', async () => {
		const { client } = await register();
		const first = await connect(client);
		const rowId = (await db.select().from(apiTokens))[0].id;
		const later = after(T0, HOUR);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		const second = await refreshGrant(db, { client, refreshToken: first.refreshToken }, later);
		stop();

		expect(second.accessToken).not.toBe(first.accessToken);
		expect(second.refreshToken).not.toBe(first.refreshToken);
		expect(second.expiresIn).toBe(3600);
		expect(second.scope).toBe(OAUTH_SCOPE);
		expect(await verifyApiToken(db, first.accessToken, later)).toBeNull();
		expect((await verifyApiToken(db, second.accessToken, later))?.id).toBe(ada.id);
		expect(await verifyApiToken(db, second.accessToken, after(later, HOUR))).toBeNull();

		const rows = await db.select().from(apiTokens);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(rowId);
		expect(rows[0].revokedAt).toBeNull();
		expect(rows[0].expiresAt).toEqual(after(later, ACCESS_TOKEN_TTL_MS));
		expect(ended).toEqual([apiTokenCredential(first.accessToken)]);

		const stored = await db.select().from(oauthRefreshTokens);
		expect(stored).toHaveLength(2);
		const old = stored.find((r) => r.tokenHash === hashSecret(first.refreshToken))!;
		expect(old.usedAt).toEqual(later);
		const fresh = stored.find((r) => r.tokenHash === hashSecret(second.refreshToken))!;
		expect(fresh.usedAt).toBeNull();
		expect(fresh.expiresAt).toEqual(after(later, REFRESH_TOKEN_TTL_MS));
	});

	it('keeps rotating along a chain of refreshes', async () => {
		const { client } = await register();
		let tokens = await connect(client);
		for (let i = 1; i <= 3; i++) {
			tokens = await refreshGrant(
				db,
				{ client, refreshToken: tokens.refreshToken },
				after(T0, i * HOUR)
			);
		}

		expect((await verifyApiToken(db, tokens.accessToken, after(T0, 3 * HOUR)))?.id).toBe(ada.id);
	});

	it('revokes the grant when a rotated refresh token is presented again', async () => {
		const { client } = await register();
		const first = await connect(client);
		const second = await refreshGrant(
			db,
			{ client, refreshToken: first.refreshToken },
			after(T0, HOUR)
		);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, 2 * HOUR)),
			'invalid_grant'
		);
		stop();

		expect(await verifyApiToken(db, second.accessToken, after(T0, 2 * HOUR))).toBeNull();
		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: second.refreshToken }, after(T0, 2 * HOUR)),
			'invalid_grant'
		);
		expect(ended).toEqual([apiTokenCredential(second.accessToken)]);
	});

	it('rejects an unknown refresh token', async () => {
		const { client } = await register();
		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: 'wlr_unknown' }),
			'invalid_grant'
		);
	});

	it('rejects an expired refresh token', async () => {
		const { client } = await register();
		const tokens = await connect(client);

		await expectOAuth(
			() =>
				refreshGrant(
					db,
					{ client, refreshToken: tokens.refreshToken },
					after(T0, REFRESH_TOKEN_TTL_MS)
				),
			'invalid_grant'
		);
		expect(
			(
				await refreshGrant(
					db,
					{ client, refreshToken: tokens.refreshToken },
					after(T0, REFRESH_TOKEN_TTL_MS - 1)
				)
			).accessToken
		).toMatch(/^wlt_/);
	});

	it('rejects a refresh token of another client without touching the grant', async () => {
		const { client } = await register();
		const other = (await register()).client;
		const tokens = await connect(client);

		await expectOAuth(
			() => refreshGrant(db, { client: other, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
		expect((await verifyApiToken(db, tokens.accessToken, T0))?.id).toBe(ada.id);
		expect(
			(await refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0)).accessToken
		).toMatch(/^wlt_/);
	});

	it('rejects the refresh token of a revoked grant', async () => {
		const { client } = await register();
		const tokens = await connect(client);
		await revokeGrant(db, await grantOf(tokens.accessToken), T0);

		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
	});
});

describe('revoking a connection', () => {
	it('kills the access token and the refresh token together', async () => {
		const { client } = await register();
		const tokens = await connect(client);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		await revokeGrant(db, await grantOf(tokens.accessToken), T0);
		stop();

		expect(await verifyApiToken(db, tokens.accessToken, T0)).toBeNull();
		expect(await credentialValid(db, apiTokenCredential(tokens.accessToken), T0)).toBe(false);
		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
		expect(ended).toEqual([apiTokenCredential(tokens.accessToken)]);
	});

	it('is idempotent and announces once', async () => {
		const { client } = await register();
		const tokens = await connect(client);
		const grantId = await grantOf(tokens.accessToken);
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		await revokeGrant(db, grantId, T0);
		const revokedAt = (await db.select().from(oauthGrants))[0].revokedAt;
		await revokeGrant(db, grantId, after(T0, HOUR));
		await revokeGrant(db, 9999, T0);
		stop();

		expect(ended).toHaveLength(1);
		expect((await db.select().from(oauthGrants))[0].revokedAt).toEqual(revokedAt);
	});

	it('leaves other connections of the same User alone', async () => {
		const { client } = await register();
		const first = await connect(client);
		const second = await connect(client);

		await revokeGrant(db, await grantOf(first.accessToken), T0);

		expect((await verifyApiToken(db, second.accessToken, T0))?.id).toBe(ada.id);
	});

	it('is what revoking the access token as an API token does', async () => {
		const { client } = await register();
		const tokens = await connect(client);
		const tokenId = (await db.select().from(apiTokens))[0].id;
		const ended: Credential[] = [];
		const stop = onRevoked((c) => ended.push(c));

		await revokeApiToken(db, ada, tokenId);
		await revokeApiToken(db, ada, tokenId);
		stop();

		expect(await verifyApiToken(db, tokens.accessToken, T0)).toBeNull();
		await expectOAuth(
			() => refreshGrant(db, { client, refreshToken: tokens.refreshToken }, T0),
			'invalid_grant'
		);
		expect((await db.select().from(oauthGrants))[0].revokedAt).not.toBeNull();
		expect(ended).toEqual([apiTokenCredential(tokens.accessToken)]);
	});

	it('is stopped for the User of another connection', async () => {
		const { client } = await register();
		await connect(client);
		const grace = await seedHuman(db, 'grace');
		const tokenId = (await db.select().from(apiTokens))[0].id;

		await expect(revokeApiToken(db, grace, tokenId)).rejects.toThrow();
		expect((await db.select().from(oauthGrants))[0].revokedAt).toBeNull();
	});
});

describe('hand-made tokens', () => {
	it('never expire and have no connection', async () => {
		const { token } = await createApiToken(db, ada, ada.id, 'laptop');
		const row = (await db.select().from(apiTokens))[0];

		expect(row.expiresAt).toBeNull();
		expect(row.grantId).toBeNull();
		expect((await verifyApiToken(db, token, after(T0, 1000 * DAY)))?.id).toBe(ada.id);
		expect(await credentialValid(db, apiTokenCredential(token), after(T0, 1000 * DAY))).toBe(true);
	});
});

describe('pruneOAuth', () => {
	const counts = async () => ({
		clients: (await db.select().from(oauthClients)).length,
		codes: (await db.select().from(oauthCodes)).length,
		grants: (await db.select().from(oauthGrants)).length,
		refresh: (await db.select().from(oauthRefreshTokens)).length,
		access: (await db.select().from(apiTokens)).length
	});

	it('keeps live rows', async () => {
		const { client } = await register();
		await connect(client);
		await authorize(client);

		await pruneOAuth(db, after(T0, 60 * 1000));

		expect(await counts()).toEqual({ clients: 1, codes: 2, grants: 1, refresh: 1, access: 1 });
	});

	it('deletes expired codes only', async () => {
		const { client } = await register();
		await authorize(client, { now: T0 });
		await authorize(client, { now: after(T0, HOUR) });
		const connected = await connect(client, after(T0, 2 * HOUR));

		await pruneOAuth(db, after(T0, HOUR + AUTHORIZATION_CODE_TTL_MS - 1));

		expect((await counts()).codes).toBe(2);
		await pruneOAuth(db, after(T0, 2 * HOUR + 1));
		expect((await counts()).codes).toBe(1);
		await pruneOAuth(db, after(T0, 2 * HOUR + AUTHORIZATION_CODE_TTL_MS));
		expect((await counts()).codes).toBe(0);
		expect((await verifyApiToken(db, connected.accessToken, after(T0, 2 * HOUR + 1)))?.id).toBe(
			ada.id
		);
	});

	it('deletes revoked grants with their tokens, keeping the client', async () => {
		const { client } = await register();
		const kept = await connect(client);
		const revoked = await connect(client);
		await revokeGrant(db, await grantOf(revoked.accessToken), T0);

		await pruneOAuth(db, after(T0, HOUR));

		expect(await counts()).toMatchObject({ grants: 1, refresh: 1, access: 1 });
		expect((await verifyApiToken(db, kept.accessToken, after(T0, HOUR - 1)))?.id).toBe(ada.id);
	});

	it('deletes a grant whose newest refresh token expired', async () => {
		const { client } = await register();
		const first = await connect(client);
		await refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, DAY));

		await pruneOAuth(db, after(T0, REFRESH_TOKEN_TTL_MS));
		expect(await counts()).toMatchObject({ grants: 1, refresh: 1 });

		await pruneOAuth(db, after(T0, DAY + REFRESH_TOKEN_TTL_MS));
		expect(await counts()).toMatchObject({ grants: 0, refresh: 0, access: 0 });
	});

	it('deletes refresh tokens rotated more than a day ago, keeping recent ones for reuse detection', async () => {
		const { client } = await register();
		const first = await connect(client);
		await refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR));

		await pruneOAuth(db, after(T0, HOUR + DAY));
		expect((await counts()).refresh).toBe(2);

		await pruneOAuth(db, after(T0, HOUR + DAY + 1));
		expect((await counts()).refresh).toBe(1);
		await expectOAuth(
			() =>
				refreshGrant(db, { client, refreshToken: first.refreshToken }, after(T0, HOUR + DAY + 1)),
			'invalid_grant'
		);
		expect((await counts()).grants).toBe(1);
	});

	it('deletes clients older than a day that have no grants', async () => {
		const old = (await register({}, T0)).client;
		const fresh = (await register({}, after(T0, DAY))).client;
		const connectedOld = (await register({}, T0)).client;
		await connect(connectedOld, after(T0, HOUR));
		await authorize(old, { now: T0 });

		await pruneOAuth(db, after(T0, DAY + HOUR));

		expect(await getClient(db, old.clientId)).toBeNull();
		expect(await getClient(db, fresh.clientId)).not.toBeNull();
		expect(await getClient(db, connectedOld.clientId)).not.toBeNull();
		expect((await counts()).codes).toBe(0);
	});

	it('keeps a client that once connected after its grants are gone, so its cached client_id still works', async () => {
		const { client } = await register({}, T0);
		const connected = await connect(client, T0);
		await revokeGrant(db, await grantOf(connected.accessToken), after(T0, HOUR));

		await pruneOAuth(db, after(T0, 2 * DAY));

		expect((await counts()).grants).toBe(0);
		expect(await getClient(db, client.clientId)).not.toBeNull();
	});

	it('removes a grant together with its tokens', async () => {
		const { client } = await register();
		await connect(client);

		await db.delete(oauthGrants);

		expect(await counts()).toMatchObject({ grants: 0, refresh: 0, access: 0 });
		expect(await getClient(db, client.clientId)).not.toBeNull();
	});

	it('removes a User’s connections when the User is deleted', async () => {
		const { client } = await register();
		await connect(client);

		await db.delete(users).where(eq(users.id, ada.id));

		expect(await counts()).toMatchObject({ grants: 0, refresh: 0, access: 0, codes: 0 });
	});
});
