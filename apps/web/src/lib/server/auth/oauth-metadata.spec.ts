import { describe, expect, it } from 'vitest';
import {
	authorizationServerMetadata,
	metadataResponse,
	protectedResourceMetadata,
	resourceMetadataUrl
} from './oauth-metadata.ts';

const origin = 'https://sagas.example';

describe('oauth metadata', () => {
	it('describes /mcp as the protected resource, with the origin as its authorization server', () => {
		expect(protectedResourceMetadata(origin)).toEqual({
			resource: 'https://sagas.example/mcp',
			authorization_servers: ['https://sagas.example'],
			scopes_supported: ['sagas'],
			bearer_methods_supported: ['header'],
			resource_name: 'sagas'
		});
	});

	it('describes the authorization server endpoints from the origin', () => {
		expect(authorizationServerMetadata(origin)).toEqual({
			issuer: 'https://sagas.example',
			authorization_endpoint: 'https://sagas.example/oauth/authorize',
			token_endpoint: 'https://sagas.example/oauth/token',
			registration_endpoint: 'https://sagas.example/oauth/register',
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
			scopes_supported: ['sagas']
		});
	});

	it('points the challenge at the unsuffixed protected-resource document', () => {
		expect(resourceMetadataUrl(origin)).toBe(
			'https://sagas.example/.well-known/oauth-protected-resource'
		);
	});

	it('serves a document as cacheable JSON', async () => {
		const response = metadataResponse(protectedResourceMetadata(origin));

		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
		expect(response.headers.get('content-type')).toMatch(/^application\/json/);
		expect(await response.json()).toEqual(protectedResourceMetadata(origin));
	});
});
