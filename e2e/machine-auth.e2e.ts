import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures/index.ts';
import { origin } from './support/env.ts';
import { cookieHeader, getNoFollow } from './support/http.ts';
import { openStream } from './support/stream.ts';

const MACHINE_PATHS = ['/mcp', '/mcp/anything', '/api/events', '/api/not-a-route'];

const basic = `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`;

async function expectUnauthorized(
	request: APIRequestContext,
	path: string,
	headers: Record<string, string> = {},
	method: 'GET' | 'POST' = 'GET'
) {
	const response =
		method === 'GET'
			? await getNoFollow(request, path, headers)
			: await request.post(path, { headers, maxRedirects: 0, data: {} });
	const label = `${method} ${path}`;
	expect(response.status(), label).toBe(401);
	const mcp = path === '/mcp' || path.startsWith('/mcp/');
	expect(response.headers()['www-authenticate'], label).toBe(
		mcp ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` : 'Bearer'
	);
	expect(response.headers()['content-type'], label).toContain('application/json');
	expect(response.headers().location, label).toBeUndefined();
	expect(await response.json(), label).toEqual({ error: 'unauthorized' });
}

test.describe('machine endpoints', () => {
	for (const path of MACHINE_PATHS) {
		test(`${path} without a token is 401 JSON`, async ({ request }) => {
			await expectUnauthorized(request, path);
		});
	}

	test('the OAuth discovery documents are public JSON', async ({ request }) => {
		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
			'/.well-known/oauth-authorization-server'
		]) {
			const response = await getNoFollow(request, path);
			expect(response.status(), path).toBe(200);
			expect(response.headers()['content-type'], path).toContain('application/json');
			expect(response.headers()['cache-control'], path).toBe('public, max-age=300');
		}
		const resource = await (
			await getNoFollow(request, '/.well-known/oauth-protected-resource')
		).json();
		expect(resource.resource).toBe(`${origin}/mcp`);
		const server = await (
			await getNoFollow(request, '/.well-known/oauth-authorization-server')
		).json();
		expect(server.issuer).toBe(origin);
	});

	test('POST /mcp without a token is 401 JSON', async ({ request }) => {
		await expectUnauthorized(request, '/mcp', {}, 'POST');
	});

	test('a bad token is 401 JSON', async ({ request }) => {
		for (const path of MACHINE_PATHS) {
			await expectUnauthorized(request, path, { authorization: 'Bearer wlt_notarealtoken' });
		}
	});

	test('a malformed Bearer header is 401 JSON', async ({ request }) => {
		for (const authorization of ['Bearer', 'Bearer ', 'Bearer two tokens', 'bearer  ']) {
			await expectUnauthorized(request, '/api/events', { authorization });
		}
	});

	test('a revoked token is 401 JSON', async ({ request, apiToken }) => {
		const headers = { authorization: `Bearer ${apiToken.token}` };
		const stream = await openStream(headers);
		expect(stream.response.status).toBe(200);
		await stream.close();

		apiToken.revoke();

		await expectUnauthorized(request, '/api/events', headers);
		await expectUnauthorized(request, '/mcp', headers);
	});

	test('a valid token passes the gate', async ({ request, apiToken }) => {
		const headers = { authorization: `Bearer ${apiToken.token}` };

		const mcp = await getNoFollow(request, '/mcp', headers);
		expect(mcp.status()).not.toBe(401);

		const missing = await getNoFollow(request, '/api/not-a-route', headers);
		expect(missing.status()).toBe(404);
	});

	test('the Bearer scheme is case-insensitive', async ({ apiToken }) => {
		const stream = await openStream({ authorization: `bearer ${apiToken.token}` });
		expect(stream.response.status).toBe(200);
		await stream.close();
	});

	test('a bad Bearer token wins over a valid session cookie', async ({
		signedInPage: page,
		request
	}) => {
		await expectUnauthorized(request, '/api/events', {
			cookie: await cookieHeader(page.context()),
			authorization: 'Bearer wlt_notarealtoken'
		});
	});

	test('a session cookie alone authenticates', async ({ signedInPage: page }) => {
		const stream = await openStream({ cookie: await cookieHeader(page.context()) });
		expect(stream.response.status).toBe(200);
		await stream.close();
	});

	test('Basic alone is 401 JSON', async ({ request }) => {
		await expectUnauthorized(request, '/api/events', { authorization: basic });
		await expectUnauthorized(request, '/mcp', { authorization: basic });
	});

	test('Basic plus a valid session cookie still counts as signed in', async ({
		signedInPage: page,
		admin
	}) => {
		const cookie = await cookieHeader(page.context());
		const stream = await openStream({ cookie, authorization: basic });
		expect(stream.response.status).toBe(200);
		await stream.close();

		await page.setExtraHTTPHeaders({ authorization: basic });
		await page.goto('/');
		await expect(page.getByText(`Signed in as ${admin.displayName}`)).toBeVisible();
	});

	test('Basic plus a bad session cookie is still signed out', async ({ request }) => {
		await expectUnauthorized(request, '/api/events', {
			cookie: 'sagas_session=wls_forged',
			authorization: basic
		});
	});

	test('pages still redirect, so only machine paths get 401', async ({ request }) => {
		const response = await getNoFollow(request, '/', { authorization: basic });
		expect(response.status()).toBe(303);
		expect(response.headers().location).toBe('/login');
	});
});
