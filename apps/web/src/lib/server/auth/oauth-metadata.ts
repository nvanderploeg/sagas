const SCOPE = 'sagas';

export function resourceMetadataUrl(origin: string): string {
	return `${origin}/.well-known/oauth-protected-resource`;
}

export function protectedResourceMetadata(origin: string) {
	return {
		resource: `${origin}/mcp`,
		authorization_servers: [origin],
		scopes_supported: [SCOPE],
		bearer_methods_supported: ['header'],
		resource_name: 'sagas'
	};
}

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		registration_endpoint: `${origin}/oauth/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
		scopes_supported: [SCOPE]
	};
}

export function metadataResponse(document: object): Response {
	return Response.json(document, { headers: { 'cache-control': 'public, max-age=300' } });
}
