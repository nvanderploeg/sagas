import type { Handle } from '#lib/server/db/client.ts';
import { OAUTH_REDIRECT_URIS, getClient, type OAuthClient, type OAuthErrorCode } from './oauth.ts';

export const OAUTH_REDIRECT_ORIGINS: string[] = [
	...new Set(OAUTH_REDIRECT_URIS.map((uri) => new URL(uri).origin))
];

type AuthorizeErrorCode = OAuthErrorCode | 'unsupported_response_type';

export type AuthorizeRequest =
	| { kind: 'invalid'; message: string }
	| { kind: 'redirect'; location: string }
	| {
			kind: 'consent';
			client: OAuthClient;
			redirectUri: string;
			codeChallenge: string;
			state: string | null;
	  };

// Callback URL for `redirectUri` carrying `params`; a query already on `redirectUri` is kept.
export function consentRedirect(redirectUri: string, params: Record<string, string>): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value);
	return url.toString();
}

// `invalid` means the client or redirect_uri cannot be trusted: show an error, never redirect.
export function readAuthorizeRequest(
	db: Handle,
	params: URLSearchParams,
	origin: string
): AuthorizeRequest {
	const clientIds = params.getAll('client_id');
	const redirectUris = params.getAll('redirect_uri');
	if (clientIds.length > 1 || redirectUris.length > 1) {
		return { kind: 'invalid', message: 'client_id and redirect_uri must each be given once' };
	}
	const client = clientIds[0] ? getClient(db, clientIds[0]) : null;
	if (!client) return { kind: 'invalid', message: 'Unknown client' };
	const redirectUri = redirectUris[0];
	if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
		return { kind: 'invalid', message: 'redirect_uri is not registered for this client' };
	}

	const state = params.get('state');
	const fail = (error: AuthorizeErrorCode, description: string): AuthorizeRequest => ({
		kind: 'redirect',
		location: consentRedirect(redirectUri, {
			error,
			error_description: description,
			...(state === null ? {} : { state })
		})
	});

	for (const name of [
		'response_type',
		'code_challenge',
		'code_challenge_method',
		'state',
		'resource'
	]) {
		if (params.getAll(name).length > 1)
			return fail('invalid_request', `${name} must be given once`);
	}
	if (params.get('response_type') !== 'code') {
		return fail('unsupported_response_type', 'response_type must be code');
	}
	const codeChallenge = params.get('code_challenge');
	if (!codeChallenge) return fail('invalid_request', 'code_challenge is required');
	if (params.get('code_challenge_method') !== 'S256') {
		return fail('invalid_request', 'code_challenge_method must be S256');
	}
	if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
		return fail('invalid_request', 'code_challenge is not a valid S256 challenge');
	}
	const resource = params.get('resource');
	if (resource !== null && resource !== `${origin}/mcp`) {
		return fail('invalid_target', `resource must be ${origin}/mcp`);
	}
	return { kind: 'consent', client, redirectUri, codeChallenge, state };
}
