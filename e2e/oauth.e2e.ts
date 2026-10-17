import { createHash, randomBytes } from 'node:crypto';
import {
	chromium,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page
} from '@playwright/test';
import { origin } from './support/env.ts';
import { postForm, uniqueName } from './support/http.ts';
import { connectMcp, expect, test } from './fixtures/mcp.ts';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CALLBACK = /^https:\/\/claude\.ai\/api\/mcp\/auth_callback/;
const RESOURCE = `${origin}/mcp`;

const base64url = (bytes: Buffer) => bytes.toString('base64url');

function pkce() {
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

type Tokens = {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
};

type Callback = { code: string | null; state: string | null; error: string | null };

function authorizeUrl(
	clientId: string,
	challenge: string,
	state: string,
	overrides: Record<string, string> = {}
): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state,
		resource: RESOURCE,
		...overrides
	});
	return `${origin}/oauth/authorize?${params}`;
}

// Chrome follows the consent redirect itself, so the form-action CSP is exercised. The sealed
// browser resolves no host but localhost: the callback request is seen and goes nowhere.
const SEALED_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'];

// Clicks, then reads the callback request Chrome sends to the redirect URI.
async function followCallback(page: Page, click: () => Promise<void>): Promise<Callback> {
	const sent = page.waitForRequest(CALLBACK);
	await click();
	const url = new URL((await sent).url());
	return {
		code: url.searchParams.get('code'),
		state: url.searchParams.get('state'),
		error: url.searchParams.get('error')
	};
}

// Runs the consent page in an already signed-in context.
async function decide(
	context: BrowserContext,
	url: string,
	decision: 'Allow' | 'Deny'
): Promise<Callback> {
	const page = await context.newPage();
	try {
		await page.goto(url);
		return await followCallback(page, () => page.getByRole('button', { name: decision }).click());
	} finally {
		await page.close();
	}
}

function exchange(
	request: APIRequestContext,
	form: Record<string, string>
): ReturnType<APIRequestContext['post']> {
	return request.post('/oauth/token', { form });
}

async function expectOAuthError(
	response: Awaited<ReturnType<typeof exchange>>,
	status: number,
	error: string
) {
	expect(response.status(), await response.text()).toBe(status);
	expect((await response.json()).error).toBe(error);
}

async function mcpStatus(request: APIRequestContext, token: string): Promise<number> {
	const response = await request.post('/mcp', {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json',
			'mcp-protocol-version': '2025-06-18'
		},
		data: { jsonrpc: '2.0', id: 1, method: 'ping' }
	});
	return response.status();
}

test.describe.serial('OAuth connector flow', () => {
	const clientName = `claude.ai e2e ${uniqueName('c')}`;
	let metadata: Record<string, unknown>;
	let clientId: string;
	let sealed: Browser;
	let signedIn: BrowserContext;
	let tokens: Tokens;
	let refreshed: Tokens;
	let pending: { verifier: string; code: string };

	// A fresh code for the registered client, with the verifier that redeems it.
	async function freshCode(): Promise<{ code: string; verifier: string }> {
		const { verifier, challenge } = pkce();
		const state = uniqueName('s');
		const callback = await decide(signedIn, authorizeUrl(clientId, challenge, state), 'Allow');
		expect(callback.state).toBe(state);
		expect(callback.code).toBeTruthy();
		return { code: callback.code!, verifier };
	}

	function redeem(request: APIRequestContext, code: string, verifier: string) {
		return exchange(request, {
			grant_type: 'authorization_code',
			client_id: clientId,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			resource: RESOURCE
		});
	}

	test.beforeAll(async () => {
		sealed = await chromium.launch({ args: SEALED_ARGS });
	});

	test.afterAll(async () => {
		await signedIn?.close();
		await sealed?.close();
	});

	test('discovers the authorization server from a bare 401', async ({ request }) => {
		const challenged = await request.post('/mcp', {
			headers: {
				accept: 'application/json, text/event-stream',
				'content-type': 'application/json'
			},
			data: { jsonrpc: '2.0', id: 1, method: 'ping' }
		});
		expect(challenged.status()).toBe(401);
		const header = challenged.headers()['www-authenticate'];
		const match = /^Bearer resource_metadata="([^"]+)"$/.exec(header);
		expect(match, header).not.toBeNull();
		expect(match![1]).toBe(`${origin}/.well-known/oauth-protected-resource`);

		const resource = await request.get(match![1]);
		expect(resource.status()).toBe(200);
		const resourceDoc = await resource.json();
		expect(resourceDoc.resource).toBe(RESOURCE);
		expect(resourceDoc.authorization_servers).toEqual([origin]);

		const server = await request.get(
			`${resourceDoc.authorization_servers[0]}/.well-known/oauth-authorization-server`
		);
		expect(server.status()).toBe(200);
		metadata = await server.json();
		expect(metadata).toMatchObject({
			issuer: origin,
			authorization_endpoint: `${origin}/oauth/authorize`,
			token_endpoint: `${origin}/oauth/token`,
			registration_endpoint: `${origin}/oauth/register`,
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256']
		});
		expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
		expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
	});

	test('registers a public client', async ({ request }) => {
		const response = await request.post(metadata.registration_endpoint as string, {
			data: {
				client_name: clientName,
				redirect_uris: [REDIRECT_URI],
				token_endpoint_auth_method: 'none'
			}
		});
		expect(response.status(), await response.text()).toBe(201);
		const body = await response.json();
		expect(body.client_id).toMatch(/^wlc_/);
		expect(body).toMatchObject({
			client_name: clientName,
			redirect_uris: [REDIRECT_URI],
			token_endpoint_auth_method: 'none'
		});
		expect(body.client_secret).toBeUndefined();
		clientId = body.client_id;
	});

	test('sends a signed-out browser through login and consent, then back to the callback', async ({
		admin
	}) => {
		signedIn = await sealed.newContext();
		const page = await signedIn.newPage();

		const { verifier, challenge } = pkce();
		const state = uniqueName('s');
		const response = await page.goto(authorizeUrl(clientId, challenge, state));
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL(/\/login\?next=%2Foauth%2Fauthorize/);

		await page.getByLabel('Username').fill(admin.username);
		await page.getByLabel('Password').fill(admin.password);
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page).toHaveURL(/\/oauth\/authorize\?/);
		await expect(page.getByRole('heading', { name: new RegExp(clientName) })).toBeVisible();
		await expect(page.locator('main').getByText(admin.displayName)).toBeVisible();
		await expect(page.getByText(`@${admin.username}`)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();

		const callback = await followCallback(page, () =>
			page.getByRole('button', { name: 'Allow' }).click()
		);
		expect(callback.error).toBeNull();
		expect(callback.state).toBe(state);
		expect(callback.code).toBeTruthy();
		pending = { verifier, code: callback.code! };
		await page.close();
	});

	test('exchanges the code for tokens', async ({ request }) => {
		const response = await redeem(request, pending.code, pending.verifier);
		expect(response.status(), await response.text()).toBe(200);
		expect(response.headers()['cache-control']).toContain('no-store');
		tokens = await response.json();
		expect(tokens.token_type).toBe('Bearer');
		expect(tokens.access_token).toMatch(/^wlt_/);
		expect(tokens.refresh_token).toMatch(/^wlr_/);
		expect(tokens.expires_in).toBe(3600);
	});

	test('calls MCP as the consenting user with the access token', async ({ admin }) => {
		const mcp = await connectMcp(tokens.access_token);
		try {
			const { user } = await mcp.ok('whoami');
			expect(user).toMatchObject({ id: admin.id, username: admin.username });
		} finally {
			await mcp.close();
		}
	});

	test('rotates both tokens on refresh', async ({ request, admin }) => {
		const response = await exchange(request, {
			grant_type: 'refresh_token',
			client_id: clientId,
			refresh_token: tokens.refresh_token,
			resource: RESOURCE
		});
		expect(response.status(), await response.text()).toBe(200);
		refreshed = await response.json();
		expect(refreshed.access_token).not.toBe(tokens.access_token);
		expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

		expect(await mcpStatus(request, tokens.access_token)).toBe(401);
		expect(await mcpStatus(request, refreshed.access_token)).toBe(200);
		const mcp = await connectMcp(refreshed.access_token);
		try {
			expect((await mcp.ok('whoami')).user.id).toBe(admin.id);
		} finally {
			await mcp.close();
		}
	});

	test('revoking the connection kills access and refresh together', async ({ request, mcp }) => {
		const { tokens: listed } = await mcp.ok('list_api_tokens');
		const connection = listed.filter(
			(t: { name: string; oauth: boolean; revokedAt: string | null }) =>
				t.oauth && t.revokedAt === null && t.name.startsWith(clientName)
		);
		expect(connection).toHaveLength(1);
		expect(connection[0].expiresAt).not.toBeNull();

		await mcp.ok('revoke_api_token', { token: connection[0].id });

		expect(await mcpStatus(request, refreshed.access_token)).toBe(401);
		await expectOAuthError(
			await exchange(request, {
				grant_type: 'refresh_token',
				client_id: clientId,
				refresh_token: refreshed.refresh_token
			}),
			400,
			'invalid_grant'
		);
	});

	test('refuses a code redeemed with the wrong verifier', async ({ request }) => {
		const { code } = await freshCode();
		await expectOAuthError(
			await redeem(request, code, base64url(randomBytes(48))),
			400,
			'invalid_grant'
		);
	});

	test('a replayed code fails and takes the first exchange down with it', async ({ request }) => {
		const { code, verifier } = await freshCode();
		const first = await redeem(request, code, verifier);
		expect(first.status(), await first.text()).toBe(200);
		const issued: Tokens = await first.json();
		expect(await mcpStatus(request, issued.access_token)).toBe(200);

		await expectOAuthError(await redeem(request, code, verifier), 400, 'invalid_grant');

		expect(await mcpStatus(request, issued.access_token)).toBe(401);
		await expectOAuthError(
			await exchange(request, {
				grant_type: 'refresh_token',
				client_id: clientId,
				refresh_token: issued.refresh_token
			}),
			400,
			'invalid_grant'
		);
	});

	test('shows an error page instead of redirecting for an unregistered redirect_uri', async () => {
		const page = await signedIn.newPage();
		const external: string[] = [];
		page.on('request', (r) => {
			if (!r.url().startsWith(origin)) external.push(r.url());
		});
		try {
			const { challenge } = pkce();
			const response = await page.goto(
				authorizeUrl(clientId, challenge, 'evil', { redirect_uri: 'https://evil.example/cb' })
			);
			expect(response?.status()).toBe(400);
			expect(page.url().startsWith(origin)).toBe(true);
			expect(external).toEqual([]);
		} finally {
			await page.close();
		}
	});

	test('answers Deny with access_denied and the same state', async () => {
		const { challenge } = pkce();
		const state = uniqueName('s');
		const callback = await decide(signedIn, authorizeUrl(clientId, challenge, state), 'Deny');
		expect(callback).toEqual({ code: null, state, error: 'access_denied' });
	});

	test('refuses to register a redirect URI outside the allowed list', async ({ request }) => {
		const response = await request.post('/oauth/register', {
			data: {
				client_name: 'evil',
				redirect_uris: ['https://evil.example/cb'],
				token_endpoint_auth_method: 'none'
			}
		});
		await expectOAuthError(response, 400, 'invalid_redirect_uri');
	});

	test('takes Origin-less form posts at /oauth/token but still refuses them elsewhere', async ({
		request,
		admin
	}) => {
		const token = await exchange(request, { grant_type: 'password', client_id: clientId });
		expect(token.status()).toBe(400);
		expect((await token.json()).error).toBe('unsupported_grant_type');

		const login = await request.post('/login', {
			form: { username: admin.username, password: admin.password },
			headers: { accept: 'text/html' },
			maxRedirects: 0
		});
		expect(login.status()).toBe(403);

		const foreign = await postForm(
			request,
			'/login',
			{ username: 'x', password: 'y' },
			{
				origin: 'https://evil.example'
			}
		);
		expect(foreign.status()).toBe(403);
	});

	test.skip('forces a password change before consent', () => {
		// No fixture creates a user who must change their password.
	});
});
