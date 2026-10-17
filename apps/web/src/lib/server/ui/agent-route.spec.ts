import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as labourRoute } from '../../../routes/api/agent/labours/[id]/+server.ts';
import { GET as meRoute } from '../../../routes/api/agent/me/+server.ts';
import { GET as realmRoute } from '../../../routes/api/agent/realms/[id]/+server.ts';
import { apiTokenCredential, sessionCredential } from '../auth/credentials.ts';
import type { AuthUser } from '../auth/users.ts';
import type { Db } from '../db/client.ts';
import { testDb } from '../test/db.ts';
import { answerSession, idParam } from './agent-route.ts';
import { readLabourLayer } from './agent.ts';

const user = { id: 1, username: 'ada' } as AuthUser;
const asSession = { user, credential: sessionCredential('s') };
const asToken = { user, credential: apiTokenCredential('t') };
const signedOut = { user: null, credential: null };

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

describe('answerSession', () => {
	it('answers a session with the read as JSON', async () => {
		const response = answerSession(asSession, () => ({ at: new Date(0), n: 1 }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ at: '1970-01-01T00:00:00.000Z', n: 1 });
	});

	it.each([
		['an API token', asToken],
		['no credential', signedOut],
		['a credential without a User', { user: null, credential: sessionCredential('s') }]
	])('answers %s with 401 and never reads', async (_name, locals) => {
		let read = false;
		const response = answerSession(locals, () => (read = true));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'unauthorized' });
		expect(read).toBe(false);
	});

	it('answers an unknown id with 404', async () => {
		const response = answerSession(asSession, () => readLabourLayer(db, 999));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'not found' });
	});

	it('lets other failures through', () => {
		expect(() =>
			answerSession(asSession, () => {
				throw new Error('boom');
			})
		).toThrow('boom');
	});
});

describe('idParam', () => {
	it('takes whole numbers only', () => {
		expect(idParam('42')).toBe(42);
		for (const bad of ['', 'x', '-1', '1.5', '1e3', '0x10', '9'.repeat(16)]) {
			expect(() => idParam(bad)).toThrow('Not found');
		}
	});
});

describe('the endpoints', () => {
	const event = (locals: object, params: Record<string, string> = { id: '1' }) =>
		({ locals, params }) as never;

	it.each([
		['Labour', labourRoute],
		['Realm', realmRoute],
		['me', meRoute]
	])('turn an API token away from the %s endpoint', async (_name, route) => {
		const response = await route(event(asToken));
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
	});

	it.each([
		['Labour', labourRoute],
		['Realm', realmRoute],
		['me', meRoute]
	])('turn a signed-out request away from the %s endpoint', async (_name, route) => {
		expect((await route(event(signedOut))).status).toBe(401);
	});
});
