import type { Db } from '#lib/server/db/client.ts';
import { OAuthError, registerClient } from './oauth.ts';
import { oauthErrorResponse, oauthJson } from './oauth-http.ts';
import { isThrottled, recordFailure } from './throttle.ts';

// RFC 7591 Dynamic Client Registration.
export async function handleRegistration(
	db: Db,
	request: Request,
	clientAddress: string,
	now = new Date()
): Promise<Response> {
	const key = `oauth-register:ip:${clientAddress}`;
	if (isThrottled([key], now.getTime())) {
		return oauthErrorResponse(
			{ error: 'invalid_request', message: 'Too many registrations. Try again in a few minutes.' },
			429
		);
	}
	recordFailure([key], now.getTime());

	const metadata = await readMetadata(request);
	if (metadata === null) {
		return oauthErrorResponse(
			{ error: 'invalid_client_metadata', message: 'Body must be a JSON object' },
			400
		);
	}

	try {
		const { client, clientSecret } = registerClient(
			db,
			{
				name: metadata.client_name,
				redirectUris: metadata.redirect_uris,
				authMethod: metadata.token_endpoint_auth_method
			},
			now
		);
		return oauthJson(
			{
				client_id: client.clientId,
				client_name: client.name,
				redirect_uris: client.redirectUris,
				token_endpoint_auth_method: client.authMethod,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
				...(clientSecret === null
					? {}
					: { client_secret: clientSecret, client_secret_expires_at: 0 })
			},
			201
		);
	} catch (e) {
		if (e instanceof OAuthError) return oauthErrorResponse(e, 400);
		throw e;
	}
}

async function readMetadata(request: Request): Promise<Record<string, unknown> | null> {
	if (!request.headers.get('content-type')?.includes('application/json')) return null;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return null;
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}
