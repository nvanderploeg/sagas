import { createHash } from 'node:crypto';
import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import {
	apiTokens,
	oauthClients,
	oauthCodes,
	oauthGrants,
	oauthRefreshTokens
} from '#lib/server/db/schema.ts';
import { announceRevoked } from './credentials.ts';
import {
	API_TOKEN_PREFIX,
	OAUTH_CLIENT_PREFIX,
	OAUTH_CLIENT_SECRET_PREFIX,
	OAUTH_CODE_PREFIX,
	OAUTH_REFRESH_PREFIX,
	generateSecret,
	hashSecret
} from './secrets.ts';

export const OAUTH_REDIRECT_URIS = [
	'https://claude.ai/api/mcp/auth_callback',
	'https://claude.com/api/mcp/auth_callback'
] as const;
export const OAUTH_SCOPE = 'sagas';
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLIENT_NAME = 'OAuth client';
const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

export type OAuthErrorCode =
	| 'invalid_request'
	| 'invalid_client'
	| 'invalid_grant'
	| 'unauthorized_client'
	| 'unsupported_grant_type'
	| 'invalid_scope'
	| 'invalid_redirect_uri'
	| 'invalid_client_metadata'
	| 'access_denied'
	| 'invalid_target';

// `error` is the RFC 6749 / 7591 error code; `message` is the error_description.
export class OAuthError extends Error {
	readonly error: OAuthErrorCode;

	constructor(error: OAuthErrorCode, description: string) {
		super(description);
		this.name = 'OAuthError';
		this.error = error;
	}
}

export type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];

export type OAuthClient = {
	clientId: string;
	name: string;
	redirectUris: string[];
	authMethod: ClientAuthMethod;
	createdAt: Date;
};

export type TokenSet = {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	scope: string;
};

type ClientRow = typeof oauthClients.$inferSelect;

function toClient(row: ClientRow): OAuthClient {
	return {
		clientId: row.id,
		name: row.name,
		redirectUris: JSON.parse(row.redirectUris) as string[],
		authMethod: row.authMethod,
		createdAt: row.createdAt
	};
}

export function registerClient(
	db: Db,
	input: { name?: unknown; redirectUris: unknown; authMethod?: unknown },
	now = new Date()
): { client: OAuthClient; clientSecret: string | null } {
	const { redirectUris } = input;
	if (
		!Array.isArray(redirectUris) ||
		redirectUris.length === 0 ||
		!redirectUris.every((uri) => (OAUTH_REDIRECT_URIS as readonly unknown[]).includes(uri))
	) {
		throw new OAuthError(
			'invalid_redirect_uri',
			'redirect_uris must be a non-empty list of registered callback URLs'
		);
	}

	let name = DEFAULT_CLIENT_NAME;
	if (input.name !== undefined) {
		if (typeof input.name !== 'string') {
			throw new OAuthError('invalid_client_metadata', 'client_name must be a string');
		}
		const trimmed = input.name.trim();
		if (trimmed.length > 100) {
			throw new OAuthError('invalid_client_metadata', 'client_name is limited to 100 characters');
		}
		if (trimmed !== '') name = trimmed;
	}

	const authMethod = input.authMethod === undefined ? 'none' : input.authMethod;
	if (!(CLIENT_AUTH_METHODS as readonly unknown[]).includes(authMethod)) {
		throw new OAuthError(
			'invalid_client_metadata',
			'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic'
		);
	}
	const method = authMethod as ClientAuthMethod;

	const clientSecret = method === 'none' ? null : generateSecret(OAUTH_CLIENT_SECRET_PREFIX);
	const row = db
		.insert(oauthClients)
		.values({
			id: generateSecret(OAUTH_CLIENT_PREFIX),
			name,
			redirectUris: JSON.stringify([...new Set(redirectUris as string[])]),
			authMethod: method,
			secretHash: clientSecret === null ? null : hashSecret(clientSecret),
			createdAt: now
		})
		.returning()
		.get();
	return { client: toClient(row), clientSecret };
}

function findClientRow(db: Handle, clientId: string): ClientRow | undefined {
	return db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
}

export function getClient(db: Handle, clientId: string): OAuthClient | null {
	const row = findClientRow(db, clientId);
	return row ? toClient(row) : null;
}

export function authenticateClient(
	db: Handle,
	clientId: string,
	secret: string | null
): OAuthClient {
	const row = findClientRow(db, clientId);
	if (!row) throw new OAuthError('invalid_client', 'Unknown client');
	if (row.authMethod !== 'none') {
		if (secret === null || row.secretHash !== hashSecret(secret)) {
			throw new OAuthError('invalid_client', 'Client authentication failed');
		}
	}
	return toClient(row);
}

export function issueCode(
	db: Db,
	input: {
		clientId: string;
		userId: number;
		redirectUri: string;
		codeChallenge: string;
		codeChallengeMethod: string;
	},
	now = new Date()
): string {
	const client = getClient(db, input.clientId);
	if (!client) throw new OAuthError('invalid_client', 'Unknown client');
	if (!client.redirectUris.includes(input.redirectUri)) {
		throw new OAuthError('invalid_redirect_uri', 'redirect_uri is not registered for this client');
	}
	if (input.codeChallengeMethod !== 'S256') {
		throw new OAuthError('invalid_request', 'code_challenge_method must be S256');
	}
	if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
		throw new OAuthError('invalid_request', 'code_challenge is not a valid S256 challenge');
	}
	const code = generateSecret(OAUTH_CODE_PREFIX);
	db.insert(oauthCodes)
		.values({
			codeHash: hashSecret(code),
			clientId: client.clientId,
			userId: input.userId,
			redirectUri: input.redirectUri,
			codeChallenge: input.codeChallenge,
			createdAt: now,
			expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS)
		})
		.run();
	return code;
}

function tokenSet(accessToken: string, refreshToken: string): TokenSet {
	return {
		accessToken,
		refreshToken,
		expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
		scope: OAUTH_SCOPE
	};
}

function insertRefreshToken(db: Handle, grantId: number, now: Date): string {
	const token = generateSecret(OAUTH_REFRESH_PREFIX);
	db.insert(oauthRefreshTokens)
		.values({
			tokenHash: hashSecret(token),
			grantId,
			createdAt: now,
			expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS)
		})
		.run();
	return token;
}

// Returns the access-token hash it ended, or null when that token was already dead.
export function revokeGrantRows(db: Handle, grantId: number, now: Date): string | null {
	db.update(oauthGrants)
		.set({ revokedAt: now })
		.where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
		.run();
	const token = db
		.select({ id: apiTokens.id, tokenHash: apiTokens.tokenHash })
		.from(apiTokens)
		.where(and(eq(apiTokens.grantId, grantId), isNull(apiTokens.revokedAt)))
		.get();
	if (!token) return null;
	db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, token.id)).run();
	return token.tokenHash;
}

function announceAccessToken(hash: string | null): void {
	if (hash !== null) announceRevoked({ kind: 'api_token', hash });
}

type Failure = { ok: false; error: OAuthError; revokedHash?: string | null };
type Exchange = { ok: true; tokens: TokenSet } | Failure;

const invalidGrant = (description: string): Failure => ({
	ok: false,
	error: new OAuthError('invalid_grant', description)
});

// Return, never throw, a failure whose writes must commit.
function settle(outcome: Exchange): TokenSet {
	if (outcome.ok) return outcome.tokens;
	announceAccessToken(outcome.revokedHash ?? null);
	throw outcome.error;
}

export function exchangeCode(
	db: Db,
	input: { client: OAuthClient; code: string; redirectUri: string; codeVerifier: string },
	now = new Date()
): TokenSet {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
		throw new OAuthError('invalid_request', 'code_verifier is not a valid PKCE verifier');
	}

	return settle(
		db.transaction((tx): Exchange => {
			const code = tx
				.select()
				.from(oauthCodes)
				.where(eq(oauthCodes.codeHash, hashSecret(input.code)))
				.get();
			if (!code || code.clientId !== input.client.clientId) {
				return invalidGrant('Authorization code is invalid');
			}
			if (code.usedAt !== null) {
				const revokedHash = code.grantId === null ? null : revokeGrantRows(tx, code.grantId, now);
				return { ...invalidGrant('Authorization code was already used'), revokedHash };
			}
			if (code.expiresAt.getTime() <= now.getTime()) {
				return invalidGrant('Authorization code has expired');
			}
			if (code.redirectUri !== input.redirectUri) {
				return invalidGrant('redirect_uri does not match the authorization request');
			}
			const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
			if (challenge !== code.codeChallenge) {
				return invalidGrant('code_verifier does not match the code_challenge');
			}

			const grant = tx
				.insert(oauthGrants)
				.values({ clientId: code.clientId, userId: code.userId, createdAt: now })
				.returning({ id: oauthGrants.id })
				.get();
			tx.update(oauthClients)
				.set({ grantedAt: now })
				.where(and(eq(oauthClients.id, code.clientId), isNull(oauthClients.grantedAt)))
				.run();
			tx.update(oauthCodes)
				.set({ usedAt: now, grantId: grant.id })
				.where(eq(oauthCodes.codeHash, code.codeHash))
				.run();
			const accessToken = generateSecret(API_TOKEN_PREFIX);
			tx.insert(apiTokens)
				.values({
					userId: code.userId,
					name: `${input.client.name} (OAuth)`,
					tokenHash: hashSecret(accessToken),
					createdAt: now,
					expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
					grantId: grant.id
				})
				.run();
			return { ok: true, tokens: tokenSet(accessToken, insertRefreshToken(tx, grant.id, now)) };
		})
	);
}

export function refreshGrant(
	db: Db,
	input: { client: OAuthClient; refreshToken: string },
	now = new Date()
): TokenSet {
	let replaced: string | null = null;

	const tokens = settle(
		db.transaction((tx): Exchange => {
			const row = tx
				.select({ refresh: oauthRefreshTokens, grant: oauthGrants })
				.from(oauthRefreshTokens)
				.innerJoin(oauthGrants, eq(oauthGrants.id, oauthRefreshTokens.grantId))
				.where(eq(oauthRefreshTokens.tokenHash, hashSecret(input.refreshToken)))
				.get();
			if (!row || row.grant.clientId !== input.client.clientId) {
				return invalidGrant('Refresh token is invalid');
			}
			if (row.grant.revokedAt !== null) return invalidGrant('Refresh token was revoked');
			if (row.refresh.usedAt !== null) {
				const revokedHash = revokeGrantRows(tx, row.grant.id, now);
				return { ...invalidGrant('Refresh token was already used'), revokedHash };
			}
			if (row.refresh.expiresAt.getTime() <= now.getTime()) {
				return invalidGrant('Refresh token has expired');
			}

			const access = tx
				.select({ id: apiTokens.id, tokenHash: apiTokens.tokenHash })
				.from(apiTokens)
				.where(eq(apiTokens.grantId, row.grant.id))
				.get();
			if (!access) return invalidGrant('Refresh token is invalid');

			tx.update(oauthRefreshTokens)
				.set({ usedAt: now })
				.where(eq(oauthRefreshTokens.tokenHash, row.refresh.tokenHash))
				.run();
			const refreshToken = insertRefreshToken(tx, row.grant.id, now);
			const accessToken = generateSecret(API_TOKEN_PREFIX);
			tx.update(apiTokens)
				.set({
					tokenHash: hashSecret(accessToken),
					expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS)
				})
				.where(eq(apiTokens.id, access.id))
				.run();
			replaced = access.tokenHash;
			return { ok: true, tokens: tokenSet(accessToken, refreshToken) };
		})
	);
	announceAccessToken(replaced);
	return tokens;
}

export function revokeGrant(db: Db, grantId: number, now = new Date()): void {
	announceAccessToken(db.transaction((tx) => revokeGrantRows(tx, grantId, now)));
}

export function pruneOAuth(db: Db, now = new Date()): void {
	const at = now.getTime();
	const dayAgo = new Date(at - DAY_MS);
	db.transaction((tx) => {
		tx.delete(oauthCodes).where(lte(oauthCodes.expiresAt, now)).run();
		// Keep before the refresh-token delete: the expiry test reads those rows.
		tx.delete(oauthGrants)
			.where(
				or(
					sql`${oauthGrants.revokedAt} IS NOT NULL`,
					sql`NOT EXISTS (
						SELECT 1 FROM oauth_refresh_tokens r
						WHERE r.grant_id = oauth_grants.id AND r.expires_at > ${at}
					)`
				)
			)
			.run();
		tx.delete(oauthRefreshTokens)
			.where(or(lte(oauthRefreshTokens.expiresAt, now), lt(oauthRefreshTokens.usedAt, dayAgo)))
			.run();
		tx.delete(oauthClients)
			.where(
				and(
					lt(oauthClients.createdAt, dayAgo),
					isNull(oauthClients.grantedAt),
					sql`NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`
				)
			)
			.run();
	});
}

export function scheduleOAuthPruning(db: Db, everyMs = 60 * 60 * 1000): () => void {
	const prune = () => {
		try {
			pruneOAuth(db);
		} catch (error) {
			console.error('sagas OAuth pruning failed', error);
		}
	};
	prune();
	const timer = setInterval(prune, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
