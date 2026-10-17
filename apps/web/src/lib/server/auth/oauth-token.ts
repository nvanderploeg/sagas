import type { Db } from '#lib/server/db/client.ts';
import { oauthErrorResponse, oauthJson } from './oauth-http.ts';
import { authenticateClient, exchangeCode, OAuthError, refreshGrant } from './oauth.ts';

type ClientCredentials = { clientId: string; secret: string | null };

const formDecode = (part: string) => decodeURIComponent(part.replace(/\+/g, ' '));

// RFC 6749 §2.3.1: Basic carries form-urlencoded id and secret.
function basicCredentials(header: string): { id: string; secret: string } {
	const invalid = () => new OAuthError('invalid_client', 'Malformed Basic credentials');
	const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
	const colon = decoded.indexOf(':');
	if (colon < 0) throw invalid();
	try {
		return {
			id: formDecode(decoded.slice(0, colon)),
			secret: formDecode(decoded.slice(colon + 1))
		};
	} catch {
		throw invalid();
	}
}

function clientCredentials(request: Request, form: URLSearchParams): ClientCredentials {
	const authorization = request.headers.get('authorization');
	const bodyId = form.get('client_id') || null;
	const bodySecret = form.get('client_secret') || null;

	if (authorization === null || !/^basic\s/i.test(authorization)) {
		if (bodyId === null) throw new OAuthError('invalid_client', 'Client authentication required');
		return { clientId: bodyId, secret: bodySecret };
	}
	if (bodySecret !== null) {
		throw new OAuthError('invalid_request', 'Use one client authentication method');
	}
	const { id, secret } = basicCredentials(authorization);
	if (bodyId !== null && bodyId !== id) {
		throw new OAuthError('invalid_request', 'client_id does not match the Basic credentials');
	}
	if (id === '') throw new OAuthError('invalid_client', 'Client authentication required');
	return { clientId: id, secret: secret || null };
}

function required(form: URLSearchParams, name: string): string {
	const value = form.get(name);
	if (!value) throw new OAuthError('invalid_request', `Missing ${name}`);
	return value;
}

// RFC 6749 §3.2: the parameters this endpoint reads must not repeat.
const SINGLE_PARAMETERS = [
	'grant_type',
	'code',
	'redirect_uri',
	'code_verifier',
	'refresh_token',
	'client_id',
	'client_secret'
];

function parseForm(text: string): URLSearchParams {
	const form = new URLSearchParams(text);
	for (const name of SINGLE_PARAMETERS) {
		if (form.getAll(name).length > 1) {
			throw new OAuthError('invalid_request', `Repeated parameter ${name}`);
		}
	}
	return form;
}

export async function handleTokenRequest(
	db: Db,
	request: Request,
	origin: string,
	now = new Date()
): Promise<Response> {
	const basic = /^basic\s/i.test(request.headers.get('authorization') ?? '');
	try {
		const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
		if (type !== 'application/x-www-form-urlencoded') {
			throw new OAuthError('invalid_request', 'Body must be application/x-www-form-urlencoded');
		}
		const form = parseForm(await request.text());
		const credentials = clientCredentials(request, form);
		const client = authenticateClient(db, credentials.clientId, credentials.secret);

		const grantType = required(form, 'grant_type');
		if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
			throw new OAuthError('unsupported_grant_type', `Unsupported grant_type ${grantType}`);
		}
		const resources = form.getAll('resource').filter((value) => value !== '');
		if (resources.some((value) => value !== `${origin}/mcp`)) {
			throw new OAuthError('invalid_target', 'resource is not this server');
		}

		const tokens =
			grantType === 'authorization_code'
				? exchangeCode(
						db,
						{
							client,
							code: required(form, 'code'),
							redirectUri: required(form, 'redirect_uri'),
							codeVerifier: required(form, 'code_verifier')
						},
						now
					)
				: refreshGrant(db, { client, refreshToken: required(form, 'refresh_token') }, now);

		return oauthJson({
			access_token: tokens.accessToken,
			token_type: 'Bearer',
			expires_in: tokens.expiresIn,
			refresh_token: tokens.refreshToken,
			scope: tokens.scope
		});
	} catch (error) {
		if (!(error instanceof OAuthError)) throw error;
		if (error.error === 'invalid_client') {
			return oauthErrorResponse(error, 401, basic ? { 'www-authenticate': 'Basic' } : {});
		}
		return oauthErrorResponse(error, 400);
	}
}
