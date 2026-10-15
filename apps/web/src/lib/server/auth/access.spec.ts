import { describe, expect, it } from 'vitest';
import { gate, isPublicPath, unauthorizedResponse } from './access.ts';
import { apiTokenCredential, sessionCredential } from './credentials.ts';
import { authFromRequest } from './request.ts';
import { createFirstAdmin } from './users.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createApiToken, revokeApiToken } from './tokens.ts';
import { createSession } from './sessions.ts';

describe('gate', () => {
	const none = { setupDone: false, signedIn: false };
	const fresh = { setupDone: true, signedIn: false };
	const inside = { setupDone: true, signedIn: true };

	it('sends every page to /setup until an Admin exists, except /setup itself', () => {
		expect(gate('/', none)).toBe('setup');
		expect(gate('/login', none)).toBe('setup');
		expect(gate('/setup', none)).toBe('pass');
	});

	it('sends signed-out pages to /login, but lets public pages through', () => {
		expect(gate('/', fresh)).toBe('login');
		expect(gate('/login', fresh)).toBe('pass');
		expect(gate('/setup', fresh)).toBe('pass');
		expect(gate('/invite/wli_abc', fresh)).toBe('pass');
		expect(gate('/logout', fresh)).toBe('pass');
	});

	it('refuses signed-out machine calls, /mcp and under /api/, with 401 rather than a redirect', () => {
		for (const path of ['/mcp', '/mcp/session', '/api/anything']) {
			expect(gate(path, fresh), path).toBe('unauthorized');
			expect(gate(path, none), path).toBe('unauthorized');
		}
		expect(gate('/mcpx', fresh)).toBe('login');
		expect(gate('/apix', fresh)).toBe('login');
	});

	it('passes every path for a signed-in request', () => {
		expect(gate('/', inside)).toBe('pass');
		expect(gate('/api/anything', inside)).toBe('pass');
		expect(gate('/mcp', inside)).toBe('pass');
	});

	it('recognises the public paths', () => {
		expect(isPublicPath('/invite/x')).toBe(true);
		expect(isPublicPath('/inviteX')).toBe(false);
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
});

describe('authFromRequest', () => {
	it('resolves a session cookie', async () => {
		const db = testDb();
		const admin = await createFirstAdmin(db, {
			username: 'root',
			displayName: 'Root',
			password: 'a long enough password'
		});
		const { token } = createSession(db, admin.id);

		const auth = authFromRequest(db, new Request('http://x/'), token);

		expect(auth?.user.id).toBe(admin.id);
		expect(auth?.credential).toEqual(sessionCredential(token));
		db.$client.close();
	});

	it('lets a Bearer header decide alone: a bad or revoked token never falls back to the cookie', async () => {
		const db = testDb();
		const admin = await createFirstAdmin(db, {
			username: 'root',
			displayName: 'Root',
			password: 'a long enough password'
		});
		const { token } = createSession(db, admin.id);
		const good = createApiToken(db, admin, admin.id, 'cli');
		const revoked = createApiToken(db, admin, admin.id, 'old');
		revokeApiToken(db, admin, revoked.id);
		const bearer = (value: string) =>
			new Request('http://x/', { headers: { authorization: value } });

		expect(authFromRequest(db, bearer('Bearer wlt_nope'), token)).toBeNull();
		expect(authFromRequest(db, bearer(`Bearer ${revoked.token}`), token)).toBeNull();
		expect(authFromRequest(db, bearer('Bearer'), token)).toBeNull();
		expect(authFromRequest(db, bearer(`bearer ${good.token}`), undefined)).toEqual({
			user: expect.objectContaining({ id: admin.id }),
			credential: apiTokenCredential(good.token)
		});
		db.$client.close();
	});

	it('falls back to the session cookie under any other Authorization scheme', async () => {
		const db = testDb();
		const admin = await createFirstAdmin(db, {
			username: 'root',
			displayName: 'Root',
			password: 'a long enough password'
		});
		const { token } = createSession(db, admin.id);
		const basic = new Request('http://x/', { headers: { authorization: 'Basic cHJveHk6cHc=' } });

		expect(authFromRequest(db, basic, token)?.user.id).toBe(admin.id);
		expect(authFromRequest(db, basic, undefined)).toBeNull();
		db.$client.close();
	});
});
