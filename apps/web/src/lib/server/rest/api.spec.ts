import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authFromRequest } from '#lib/server/auth/request.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { fakeSessions } from '#lib/server/auth/fixtures.ts';
import { insertApiToken, revokeApiToken } from '#lib/server/auth/tokens.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { createLabour } from '#lib/server/domain/labours.ts';
import { acceptOffer, offerMembership } from '#lib/server/domain/memberships.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
import { createState } from '#lib/server/domain/states.ts';
import { testDb } from '#lib/server/test/db.ts';
import { handleRest } from './api.ts';

const ORIGIN = 'http://sagas.test';

let db: Db;
let ada: AuthUser;
let bob: AuthUser;
let eve: AuthUser;
let adaToken: { id: number; token: string };
let bobToken: { id: number; token: string };
let eveToken: { id: number; token: string };

type Opts = { method?: string; token?: string; session?: string; body?: unknown };

async function call(path: string, opts: Opts = {}) {
	const url = new URL(ORIGIN + '/api/v1' + path);
	const headers: Record<string, string> = {};
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	const request = new Request(url, { method: opts.method ?? 'GET', headers });
	const auth = await authFromRequest(db, request, opts.session);
	const response = await handleRest(db, auth, {
		method: request.method,
		origin: ORIGIN,
		segments: url.pathname
			.replace('/api/v1', '')
			.split('/')
			.filter((part) => part !== ''),
		query: url.searchParams,
		body: async () => {
			if (opts.body === undefined) throw new Error('no body');
			return opts.body;
		}
	});
	return { status: response.status, json: (await response.json()) as any };
}

beforeEach(async () => {
	setAccessEnforced(true);
	db = await testDb();
	ada = await seedHuman(db, 'ada');
	bob = await seedHuman(db, 'bob');
	eve = await seedHuman(db, 'eve');
	adaToken = await insertApiToken(db, ada.id, 'ada');
	bobToken = await insertApiToken(db, bob.id, 'bob');
	eveToken = await insertApiToken(db, eve.id, 'eve');
	const realm = await createRealm(db, ada, {
		name: 'Atlas',
		key: 'am',
		initialState: { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' }
	});
	await createState(db, ada, realm.id, {
		key: 'doing',
		label: 'Doing',
		color: '#3b82f6',
		icon: 'circle'
	});
	await createLabour(db, ada, {
		realmId: realm.id,
		title: 'First',
		ownerId: ada.id,
		assigneeId: null
	});
	await offerMembership(db, ada, realm.id, bob.id, 'viewer');
	await acceptOffer(db, bob, realm.id);
});

afterEach(() => {
	setAccessEnforced(false);
});

describe('authentication', () => {
	it('refuses a request with no credential', async () => {
		const res = await call('/realms');
		expect(res.status).toBe(401);
	});

	it('refuses a revoked token', async () => {
		await revokeApiToken(db, ada, adaToken.id);
		expect((await call('/realms', { token: adaToken.token })).status).toBe(401);
	});

	it('lets a session read but refuses its writes', async () => {
		const sessions = fakeSessions();
		const session = { token: await sessions.open(db, ada) };
		const read = await call('/labours/AM-1', { session: session.token });
		const write = await call('/labours/AM-1', {
			method: 'PATCH',
			session: session.token,
			body: { title: 'x' }
		});
		const comment = await call('/labours/AM-1/comments', {
			method: 'POST',
			session: session.token,
			body: { body: 'x' }
		});

		expect(read.status).toBe(200);
		expect(write.status).toBe(403);
		expect(comment.status).toBe(403);
		expect((await call('/labours/AM-1', { token: adaToken.token })).json.labour.title).toBe(
			'First'
		);
		sessions.restore();
	});
});

describe('realms', () => {
	it('lists member Realms with States in board order', async () => {
		const { json } = await call('/realms', { token: adaToken.token });

		expect(json.realms).toHaveLength(1);
		expect(json.realms[0]).toMatchObject({ key: 'AM', name: 'Atlas' });
		expect(json.realms[0].states.map((s: any) => [s.key, s.order])).toEqual([
			['todo', 0],
			['doing', 1],
			['closed', 2]
		]);
		expect(json.realms[0].states[0]).toHaveProperty('substates');
	});

	it('hides a Realm from a non-member', async () => {
		expect((await call('/realms', { token: eveToken.token })).json.realms).toEqual([]);
		expect((await call('/realms/am', { token: eveToken.token })).status).toBe(404);
		expect((await call('/realms/am', { token: adaToken.token })).json.realm.key).toBe('AM');
	});
});

describe('labours', () => {
	it('lists with the stable id and key', async () => {
		const { json } = await call('/labours?realm=am&state=todo', { token: adaToken.token });

		expect(json.labours).toMatchObject([
			{ key: 'AM-1', title: 'First', state: 'todo', substate: null, assignee: null, labels: [] }
		]);
		expect(typeof json.labours[0].id).toBe('number');
		expect(json.labours[0]).toHaveProperty('rank');
		expect(json.labours[0]).toHaveProperty('updatedAt');
		expect(json.nextCursor).toBeNull();
	});

	it('pages with a cursor', async () => {
		const realm = (await call('/realms/am', { token: adaToken.token })).json.realm;
		await createLabour(db, ada, {
			realmId: realm.id,
			title: 'Second',
			ownerId: ada.id,
			assigneeId: null
		});

		const first = await call('/labours?realm=AM&limit=1', { token: adaToken.token });
		const second = await call(`/labours?realm=AM&limit=1&cursor=${first.json.nextCursor}`, {
			token: adaToken.token
		});

		expect(first.json.labours[0].key).toBe('AM-1');
		expect(second.json.labours[0].key).toBe('AM-2');
		expect(second.json.nextCursor).toBeNull();
	});

	it('refuses a bad limit, cursor, or State without a Realm', async () => {
		for (const q of ['limit=0', 'limit=x', 'cursor=-1', 'state=todo']) {
			expect((await call(`/labours?${q}`, { token: adaToken.token })).status, q).toBe(400);
		}
	});

	it('finds nothing in a Realm the caller is not in', async () => {
		expect((await call('/labours', { token: eveToken.token })).json.labours).toEqual([]);
		expect((await call('/labours?realm=AM', { token: eveToken.token })).status).toBe(404);
		expect((await call('/labours/AM-1', { token: eveToken.token })).status).toBe(404);
		expect((await call('/labours/AM-1/comments', { token: eveToken.token })).status).toBe(404);
		const patch = await call('/labours/AM-1', {
			method: 'PATCH',
			token: eveToken.token,
			body: { title: 'x' }
		});
		expect(patch.status).toBe(404);
	});

	it('answers 404 for a missing Labour or a malformed key', async () => {
		expect((await call('/labours/AM-99', { token: adaToken.token })).status).toBe(404);
		expect((await call('/labours/nonsense', { token: adaToken.token })).status).toBe(404);
	});

	it('resolves an alias key to the same Labour id', async () => {
		const before = (await call('/labours/AM-1', { token: adaToken.token })).json.labour;
		const realm = (await call('/realms/AM', { token: adaToken.token })).json.realm;
		const { renameRealmKey } = await import('#lib/server/domain/realms.ts');
		await renameRealmKey(db, ada, realm.id, 'atl');

		const after = await call('/labours/AM-1', { token: adaToken.token });

		expect(after.json.labour).toMatchObject({ id: before.id, key: 'ATL-1' });
		expect(after.json.labour.aliases).toContain('AM-1');
		expect(after.json.labour).toHaveProperty('links');
		expect(after.json.labour.children).toEqual([]);
	});
});

describe('PATCH', () => {
	it('lets an editor change fields and move State, visible on GET', async () => {
		const realm = (await call('/realms/am', { token: adaToken.token })).json.realm;
		await offerMembership(db, ada, realm.id, eve.id, 'editor');
		await acceptOffer(db, eve, realm.id);

		const patched = await call('/labours/am-1', {
			method: 'PATCH',
			token: eveToken.token,
			body: {
				title: 'Renamed',
				description: 'Body',
				assignee: 'bob',
				state: 'doing',
				labels: ['Wayfinder:Map']
			}
		});
		const read = await call('/labours/AM-1', { token: adaToken.token });

		expect(patched.status).toBe(200);
		expect(read.json.labour).toMatchObject({
			title: 'Renamed',
			description: 'Body',
			assignee: 'bob',
			state: 'doing',
			labels: ['wayfinder:map']
		});
		const board = await call('/labours?realm=AM&state=doing', { token: adaToken.token });
		expect(board.json.labours.map((l: any) => l.key)).toEqual(['AM-1']);
	});

	it('clears the assignee with null', async () => {
		await call('/labours/AM-1', {
			method: 'PATCH',
			token: adaToken.token,
			body: { assignee: 'me' }
		});
		const cleared = await call('/labours/AM-1', {
			method: 'PATCH',
			token: adaToken.token,
			body: { assignee: null }
		});
		expect(cleared.json.labour.assignee).toBeNull();
	});

	it('refuses a viewer with 403', async () => {
		const res = await call('/labours/AM-1', {
			method: 'PATCH',
			token: bobToken.token,
			body: { title: 'x' }
		});
		expect(res.status).toBe(403);
	});

	it('refuses unknown fields, bad types and unknown references with 400', async () => {
		for (const body of [
			{ owner: 'bob' },
			{ title: 5 },
			{ state: 'nowhere' },
			{ assignee: 'ghost' },
			{ substate: 'x' },
			[]
		]) {
			const res = await call('/labours/AM-1', { method: 'PATCH', token: adaToken.token, body });
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(typeof res.json.error).toBe('string');
		}
	});

	it('refuses a body that is not JSON with 400', async () => {
		const res = await call('/labours/AM-1', { method: 'PATCH', token: adaToken.token });
		expect(res.status).toBe(400);
	});
});

describe('comments', () => {
	it('lets an editor post and everyone who sees the Labour read', async () => {
		const posted = await call('/labours/AM-1/comments', {
			method: 'POST',
			token: adaToken.token,
			body: { body: 'hello' }
		});
		const read = await call('/labours/AM-1/comments', { token: bobToken.token });

		expect(posted.status).toBe(201);
		expect(read.json.comments).toMatchObject([{ author: 'ada', body: 'hello', labour: 'AM-1' }]);
	});

	it('refuses a viewer with 403 and a bad body with 400', async () => {
		const viewer = await call('/labours/AM-1/comments', {
			method: 'POST',
			token: bobToken.token,
			body: { body: 'x' }
		});
		const empty = await call('/labours/AM-1/comments', {
			method: 'POST',
			token: adaToken.token,
			body: { body: '' }
		});
		const extra = await call('/labours/AM-1/comments', {
			method: 'POST',
			token: adaToken.token,
			body: { body: 'x', author: 'bob' }
		});

		expect(viewer.status).toBe(403);
		expect(empty.status).toBe(400);
		expect(extra.status).toBe(400);
	});
});

describe('routing', () => {
	it('answers 404 for an unknown path and 405 for an unsupported method', async () => {
		expect((await call('/nothing', { token: adaToken.token })).status).toBe(404);
		expect((await call('/realms', { method: 'POST', token: adaToken.token })).status).toBe(405);
	});
});
