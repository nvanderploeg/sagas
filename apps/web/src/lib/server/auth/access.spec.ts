import { describe, expect, it } from 'vitest';
import { gate, isPublicPath } from './access.ts';
import { userFromRequest } from './request.ts';
import { createFirstAdmin } from './users.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createApiToken } from './tokens.ts';
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

	it('refuses signed-out API calls with 401 rather than a redirect', () => {
		expect(gate('/api/anything', fresh)).toBe('unauthorized');
		expect(gate('/api/anything', none)).toBe('unauthorized');
	});

	it('passes every path for a signed-in request', () => {
		expect(gate('/', inside)).toBe('pass');
		expect(gate('/api/anything', inside)).toBe('pass');
	});

	it('recognises the public paths', () => {
		expect(isPublicPath('/invite/x')).toBe(true);
		expect(isPublicPath('/inviteX')).toBe(false);
		expect(isPublicPath('/projects')).toBe(false);
	});
});

describe('userFromRequest', () => {
	it('resolves a session cookie', async () => {
		const db = testDb();
		const admin = await createFirstAdmin(db, {
			username: 'root',
			displayName: 'Root',
			password: 'a long enough password'
		});
		const { token } = createSession(db, admin.id);

		const user = userFromRequest(db, new Request('http://x/'), token);

		expect(user?.id).toBe(admin.id);
		db.$client.close();
	});

	it('lets a bearer header decide alone, without falling back to the cookie', async () => {
		const db = testDb();
		const admin = await createFirstAdmin(db, {
			username: 'root',
			displayName: 'Root',
			password: 'a long enough password'
		});
		const { token } = createSession(db, admin.id);

		const bad = new Request('http://x/', { headers: { authorization: 'Bearer wlt_nope' } });
		const malformed = new Request('http://x/', { headers: { authorization: 'Basic abc' } });
		const good = createApiToken(db, admin, admin.id, 'cli');
		const ok = new Request('http://x/', { headers: { authorization: `Bearer ${good.token}` } });

		expect(userFromRequest(db, bad, token)).toBeNull();
		expect(userFromRequest(db, malformed, token)).toBeNull();
		expect(userFromRequest(db, ok, undefined)?.id).toBe(admin.id);
		db.$client.close();
	});
});
