import { fakeSessions, seedAdmin } from './fixtures.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gate, isMcpPath, isPublicPath, unauthorizedResponse } from './access.ts';
import { apiTokenCredential, sessionCredential } from './credentials.ts';
import { authFromRequest } from './request.ts';
import { eq } from 'drizzle-orm';
import { users } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createApiToken, revokeApiToken } from './tokens.ts';

describe('gate', () => {
	const out = { signedIn: false };
	const inside = { signedIn: true };

	it('sends signed-out pages to /login, but lets public pages through', () => {
		expect(gate('/', out)).toBe('login');
		expect(gate('/login', out)).toBe('pass');
		expect(gate('/login/session', out)).toBe('pass');
		expect(gate('/logout', out)).toBe('pass');
		expect(gate('/setup', out)).toBe('login');
		expect(gate('/invite/wli_abc', out)).toBe('login');
	});

	it('refuses signed-out machine calls, /mcp and under /api/, with 401 rather than a redirect', () => {
		for (const path of ['/mcp', '/mcp/session', '/api/anything']) {
			expect(gate(path, out), path).toBe('unauthorized');
		}
		expect(gate('/mcpx', out)).toBe('login');
		expect(gate('/apix', out)).toBe('login');
	});

	it('passes every path for a signed-in request', () => {
		expect(gate('/', inside)).toBe('pass');
		expect(gate('/api/anything', inside)).toBe('pass');
		expect(gate('/mcp', inside)).toBe('pass');
	});

	it('passes the OAuth discovery and client endpoints signed out', () => {
		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
			'/.well-known/oauth-authorization-server',
			'/oauth/register',
			'/oauth/token'
		]) {
			expect(gate(path, out), path).toBe('pass');
		}
	});

	it('keeps /oauth/authorize a normal page', () => {
		expect(gate('/oauth/authorize', out)).toBe('login');
		expect(gate('/oauth/authorize', inside)).toBe('pass');
	});

	it('recognises the MCP paths', () => {
		expect(isMcpPath('/mcp')).toBe(true);
		expect(isMcpPath('/mcp/session')).toBe(true);
		expect(isMcpPath('/mcpx')).toBe(false);
		expect(isMcpPath('/api/mcp')).toBe(false);
	});

	it('recognises the public paths', () => {
		expect(isPublicPath('/login')).toBe(true);
		expect(isPublicPath('/login/session')).toBe(true);
		expect(isPublicPath('/invite/x')).toBe(false);
		expect(isPublicPath('/realms')).toBe(false);
	});
});

describe('unauthorizedResponse', () => {
	it('answers 401 with a Bearer challenge and a JSON body', async () => {
		const response = unauthorizedResponse();

		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		expect(response.headers.get('content-type')).toMatch(/^application\/json/);
		expect(await response.json()).toEqual({ error: 'unauthorized' });
	});

	it('points the challenge at the resource metadata when given one', async () => {
		const response = unauthorizedResponse('https://x.test/.well-known/oauth-protected-resource');

		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			'Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"'
		);
		expect(await response.json()).toEqual({ error: 'unauthorized' });
	});
});

describe('authFromRequest', () => {
	let sessions: ReturnType<typeof fakeSessions>;
	beforeEach(() => {
		sessions = fakeSessions();
	});
	afterEach(() => sessions.restore());

	it('resolves a session cookie', async () => {
		const db = await testDb();
		const admin = await seedAdmin(db, 'root', 'Root');
		const token = await sessions.open(db, admin);

		const auth = await authFromRequest(db, new Request('http://x/'), token);

		expect(auth?.user.id).toBe(admin.id);
		expect(auth?.credential).toEqual(sessionCredential(token));
	});

	it("creates this app's User on the first verified request", async () => {
		const db = await testDb();
		const token = sessions.openIdentity({
			uid: 'new-uid',
			email: 'new.person@example.com',
			emailVerified: true,
			name: 'New Person'
		});

		const auth = await authFromRequest(db, new Request('http://x/'), token);

		expect(auth?.user).toMatchObject({ kind: 'human', username: 'newperson', realmLimit: 1 });
		expect((await authFromRequest(db, new Request('http://x/'), token))?.user.id).toBe(
			auth?.user.id
		);
	});

	it('refuses a cookie whose email is not verified', async () => {
		const db = await testDb();
		const token = sessions.openIdentity({
			uid: 'u2',
			email: 'a@example.com',
			emailVerified: false,
			name: null
		});

		expect(await authFromRequest(db, new Request('http://x/'), token)).toBeNull();
	});

	it('refuses a session cookie Firebase no longer vouches for', async () => {
		const db = await testDb();
		const admin = await seedAdmin(db, 'root', 'Root');
		const token = await sessions.open(db, admin);
		sessions.end(token);

		expect(await authFromRequest(db, new Request('http://x/'), token)).toBeNull();
	});

	it('refuses a valid cookie whose Firebase account has no User', async () => {
		const db = await testDb();
		const admin = await seedAdmin(db, 'root', 'Root');
		const token = await sessions.open(db, admin);
		await db.delete(users).where(eq(users.id, admin.id));

		expect(await authFromRequest(db, new Request('http://x/'), token)).toBeNull();
	});

	it('lets a Bearer header decide alone: a bad or revoked token never falls back to the cookie', async () => {
		const db = await testDb();
		const admin = await seedAdmin(db, 'root', 'Root');
		const token = await sessions.open(db, admin);
		const good = await createApiToken(db, admin, admin.id, 'cli');
		const revoked = await createApiToken(db, admin, admin.id, 'old');
		await revokeApiToken(db, admin, revoked.id);
		const bearer = (value: string) =>
			new Request('http://x/', { headers: { authorization: value } });

		expect(await authFromRequest(db, bearer('Bearer wlt_nope'), token)).toBeNull();
		expect(await authFromRequest(db, bearer(`Bearer ${revoked.token}`), token)).toBeNull();
		expect(await authFromRequest(db, bearer('Bearer'), token)).toBeNull();
		expect(await authFromRequest(db, bearer(`bearer ${good.token}`), undefined)).toEqual({
			user: expect.objectContaining({ id: admin.id }),
			credential: apiTokenCredential(good.token)
		});
	});

	it('falls back to the session cookie under any other Authorization scheme', async () => {
		const db = await testDb();
		const admin = await seedAdmin(db, 'root', 'Root');
		const token = await sessions.open(db, admin);
		const basic = new Request('http://x/', { headers: { authorization: 'Basic cHJveHk6cHc=' } });

		expect((await authFromRequest(db, basic, token))?.user.id).toBe(admin.id);
		expect(await authFromRequest(db, basic, undefined)).toBeNull();
	});
});
