import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { defineAttribute, setValues } from '#lib/server/agent/attributes.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours, mentions, surveys } from '#lib/server/db/schema.ts';
import { renameRealmKey } from '#lib/server/domain/realms.ts';
import { updateLabour } from '#lib/server/domain/labours.ts';
import { addQuestLabours, createQuest } from '#lib/server/domain/quests.ts';
import { listStates } from '#lib/server/domain/states.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import {
	seedActor,
	seedLabour,
	seedRealm,
	seedUser,
	anyRealmId
} from '#lib/server/test/fixtures.ts';
import { createMcpServer } from '../server.ts';

let db: Db;
let admin: AuthUser;
let actor: Actor;
const clients: Client[] = [];

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
	actor = seedActor(db);
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

const DAY = 86_400_000;

async function connect(user: AuthUser = admin): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, user, 'http://sagas.test').connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

async function call(client: Client, args: Record<string, unknown>) {
	return (await client.callTool({ name: 'survey', arguments: args })) as CallToolResult;
}

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

async function ok(client: Client, args: Record<string, unknown>) {
	const result = await call(client, args);
	expect(result.isError, text(result)).toBeFalsy();
	return result.structuredContent as any;
}

async function fail(client: Client, args: Record<string, unknown>) {
	const result = await call(client, args);
	expect(result.isError, 'the call should fail').toBe(true);
	return (result.structuredContent as any).error as { code: string; message: string };
}

const keys = (survey: { results: { key: string }[] }) => survey.results.map((r) => r.key);
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as any;
const NEUTRAL = { evidence: 1 };

function closeLabour(labour: { id: number; realmId: number }, updatedAgoDays?: number) {
	const closed = listStates(db, labour.realmId).find((s) => s.isClosed)!;
	updateLabour(db, actor, labour.id, { stateId: closed.id });
	if (updatedAgoDays !== undefined) {
		db.update(labours)
			.set({ updatedAt: new Date(Date.now() - updatedAgoDays * DAY) })
			.where(eq(labours.id, labour.id))
			.run();
	}
}

describe('the survey tool', () => {
	it('is a write tool with a closed input schema that requires only weights', async () => {
		const { tools } = await (await connect()).listTools();

		const tool = tools.find((t) => t.name === 'survey')!;

		expect(tool.description).toBeTruthy();
		expect(tool.annotations?.readOnlyHint).toBe(false);
		expect(tool.annotations?.destructiveHint).toBe(false);
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(tool.inputSchema.required).toEqual(['weights']);
		expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(
			['filter', 'for', 'limit', 'query', 'realm', 'show', 'temperature', 'weights'].sort()
		);
		expect((tool.inputSchema.properties as any).filter.additionalProperties).toBe(false);
	});

	it('answers with keys, usernames and paths, never internal ids', async () => {
		const am = seedRealm(db, 'AM');
		const bob = seedUser(db, 'bob');
		defineAttribute(db, actor, am.id, {
			key: 'impact',
			kind: 'scale',
			label: 'Impact',
			rubric: 'rubric',
			spec: { min: 0, max: 4 }
		});
		const low = seedLabour(db, { realmId: am.id, title: 'Low' });
		const high = seedLabour(db, { realmId: am.id, title: 'High', assigneeId: bob });
		setValues(db, actor, low.id, { impact: 1 });
		setValues(db, actor, high.id, { impact: 4 });
		appraise(db, actor, [{ labourId: high.id, brief: 'Players hit this daily' }]);

		const survey = await ok(await connect(), { weights: { impact: 1 }, temperature: 0 });

		expect(survey).toEqual({
			survey: expect.any(Number),
			results: [
				{
					key: 'AM-2',
					path: '/l/AM-2',
					url: 'http://sagas.test/l/AM-2',
					title: 'High',
					realm: 'AM',
					state: 'todo',
					assignee: 'bob',
					brief: 'Players hit this daily',
					score: 1,
					contributions: { impact: 1 }
				},
				{
					key: 'AM-1',
					path: '/l/AM-1',
					url: 'http://sagas.test/l/AM-1',
					title: 'Low',
					realm: 'AM',
					state: 'todo',
					assignee: null,
					brief: '',
					score: 0.25,
					contributions: { impact: 0.25 }
				}
			],
			sentiment: [],
			coverage: { candidates: 2, unappraised: 2, stale: 0, unembedded: 2, missing: {} },
			ignored: []
		});
	});

	it('puts a one-line summary before the JSON in the text', async () => {
		const am = seedRealm(db, 'AM');
		seedLabour(db, { realmId: am.id });

		const result = await call(await connect(), { weights: NEUTRAL });

		const [summary, ...rest] = text(result).split('\n');
		expect(summary).toBeTruthy();
		expect(JSON.parse(rest.join('\n'))).toEqual(result.structuredContent);
	});

	it('stores the Survey as the calling User, for them by default, and returns its id', async () => {
		const am = seedRealm(db, 'AM');
		seedLabour(db, { realmId: am.id });

		const survey = await ok(await connect(), { weights: NEUTRAL, query: 'boss' });

		const row = db.select().from(surveys).where(eq(surveys.id, survey.survey)).get()!;
		expect(db.select().from(surveys).all()).toHaveLength(1);
		expect(row.actorId).toBe(admin.id);
		expect(row.forId).toBe(admin.id);
		expect(json(row.request)).toMatchObject({ weights: NEUTRAL, query: 'boss' });
	});

	it('records no Event and leaves every Labour as it was', async () => {
		const am = seedRealm(db, 'AM');
		seedLabour(db, { realmId: am.id });
		const eventsBefore = db.select().from(events).all();
		const laboursBefore = db.select().from(labours).all();

		await ok(await connect(), { weights: { age: 1, activity: 1 }, temperature: 1 });

		expect(db.select().from(events).all()).toEqual(eventsBefore);
		expect(db.select().from(labours).all()).toEqual(laboursBefore);
	});

	describe('realm', () => {
		function fixture() {
			const am = seedRealm(db, 'AM');
			const bl = seedRealm(db, 'BL');
			const cx = seedRealm(db, 'CX');
			seedLabour(db, { realmId: am.id });
			seedLabour(db, { realmId: bl.id });
			seedLabour(db, { realmId: cx.id });
			return { am, bl, cx };
		}

		it('surveys every Realm when absent', async () => {
			fixture();

			expect(keys(await ok(await connect(), { weights: NEUTRAL }))).toEqual([
				'AM-1',
				'BL-1',
				'CX-1'
			]);
		});

		it('takes one Realm as a key in any case or as an id', async () => {
			const { bl } = fixture();
			const client = await connect();

			expect(keys(await ok(client, { weights: NEUTRAL, realm: 'bl' }))).toEqual(['BL-1']);
			expect(keys(await ok(client, { weights: NEUTRAL, realm: bl.id }))).toEqual(['BL-1']);
		});

		it('takes a list of Realms, keys and ids mixed', async () => {
			const { am, cx } = fixture();
			const client = await connect();

			expect(keys(await ok(client, { weights: NEUTRAL, realm: ['cx', am.id] }))).toEqual([
				'AM-1',
				'CX-1'
			]);
			expect(keys(await ok(client, { weights: NEUTRAL, realm: [cx.id] }))).toEqual(['CX-1']);
		});

		it('resolves a former Realm key', async () => {
			const { am } = fixture();
			renameRealmKey(db, actor, am.id, 'NU');

			const survey = await ok(await connect(), { weights: NEUTRAL, realm: 'AM' });

			expect(survey.results).toMatchObject([{ key: 'NU-1', realm: 'NU' }]);
		});

		it('answers not_found for an unknown Realm, alone or in a list', async () => {
			fixture();
			const client = await connect();

			expect((await fail(client, { weights: NEUTRAL, realm: 'ZZ' })).code).toBe('not_found');
			expect((await fail(client, { weights: NEUTRAL, realm: 9999 })).code).toBe('not_found');
			expect((await fail(client, { weights: NEUTRAL, realm: ['AM', 'ZZ'] })).code).toBe(
				'not_found'
			);
		});

		it('refuses an empty list and a digit string', async () => {
			fixture();
			const client = await connect();

			expect((await fail(client, { weights: NEUTRAL, realm: [] })).code).toBe('invalid');
			expect((await fail(client, { weights: NEUTRAL, realm: '12' })).code).toBe('invalid');
		});
	});

	describe('for', () => {
		function fixture() {
			const am = seedRealm(db, 'AM');
			const bob = seedUser(db, 'bob');
			const mine = seedLabour(db, { realmId: am.id });
			const his = seedLabour(db, { realmId: am.id });
			db.insert(mentions)
				.values([
					{
						sourceLabourId: mine.id,
						userId: admin.id,
						commentId: null,
						authorId: actor.id,
						firstSeenAt: new Date()
					},
					{
						sourceLabourId: his.id,
						userId: bob,
						commentId: null,
						authorId: actor.id,
						firstSeenAt: new Date()
					}
				])
				.run();
			return { bob };
		}

		const forId = (surveyId: number) =>
			db.select().from(surveys).where(eq(surveys.id, surveyId)).get()!.forId;

		it('defaults to the caller, and "me" is the caller', async () => {
			fixture();
			const client = await connect();

			const absent = await ok(client, { weights: { pulled_in: 1 }, temperature: 0 });
			const me = await ok(client, { weights: { pulled_in: 1 }, temperature: 0, for: 'me' });

			expect(forId(absent.survey)).toBe(admin.id);
			expect(forId(me.survey)).toBe(admin.id);
			expect(keys(me)[0]).toBe('AM-1');
			expect(me.results[0].score).toBeGreaterThan(0);
			expect(me.results[1].score).toBe(0);
		});

		it('takes a username in any case or an id', async () => {
			const { bob } = fixture();
			const client = await connect();

			const byName = await ok(client, { weights: { pulled_in: 1 }, temperature: 0, for: 'BOB' });
			const byId = await ok(client, { weights: { pulled_in: 1 }, temperature: 0, for: bob });

			expect(forId(byName.survey)).toBe(bob);
			expect(forId(byId.survey)).toBe(bob);
			expect(keys(byName)[0]).toBe('AM-2');
			expect(byName.results[0].score).toBeGreaterThan(0);
			expect(byName.results[1].score).toBe(0);
		});

		it('answers not_found for an unknown User', async () => {
			fixture();
			const client = await connect();

			expect((await fail(client, { weights: NEUTRAL, for: 'nobody' })).code).toBe('not_found');
			expect((await fail(client, { weights: NEUTRAL, for: 9999 })).code).toBe('not_found');
		});
	});

	describe('filter', () => {
		it('takes assignee as usernames and null for unassigned', async () => {
			const am = seedRealm(db, 'AM');
			const bob = seedUser(db, 'bob');
			const carol = seedUser(db, 'carol');
			seedLabour(db, { realmId: am.id });
			seedLabour(db, { realmId: am.id, assigneeId: bob });
			seedLabour(db, { realmId: am.id, assigneeId: carol });
			const client = await connect();

			const both = await ok(client, {
				weights: NEUTRAL,
				filter: { assignee: [null, 'bob'] }
			});
			const only = await ok(client, { weights: NEUTRAL, filter: { assignee: ['CAROL'] } });
			const nobody = await ok(client, { weights: NEUTRAL, filter: { assignee: [null] } });

			expect(keys(both)).toEqual(['AM-1', 'AM-2']);
			expect(both.results.map((r: any) => r.assignee)).toEqual([null, 'bob']);
			expect(keys(only)).toEqual(['AM-3']);
			expect(keys(nobody)).toEqual(['AM-1']);
		});

		it('answers not_found for an unknown assignee and invalid for an empty list', async () => {
			const am = seedRealm(db, 'AM');
			seedLabour(db, { realmId: am.id });
			const client = await connect();

			expect(
				(await fail(client, { weights: NEUTRAL, filter: { assignee: ['nobody'] } })).code
			).toBe('not_found');
			expect((await fail(client, { weights: NEUTRAL, filter: { assignee: [] } })).code).toBe(
				'invalid'
			);
		});

		it('leaves Closed Labours out unless include_closed says otherwise', async () => {
			const am = seedRealm(db, 'AM');
			seedLabour(db, { realmId: am.id });
			const recent = seedLabour(db, { realmId: am.id });
			const old = seedLabour(db, { realmId: am.id });
			closeLabour(recent, 2);
			closeLabour(old, 10);
			const client = await connect();

			expect(keys(await ok(client, { weights: NEUTRAL }))).toEqual(['AM-1']);
			expect(
				keys(await ok(client, { weights: NEUTRAL, filter: { include_closed: true } }))
			).toEqual(['AM-1', 'AM-2', 'AM-3']);
			expect(
				keys(await ok(client, { weights: NEUTRAL, filter: { include_closed: { within_days: 5 } } }))
			).toEqual(['AM-1', 'AM-2']);
		});

		it('refuses a within_days outside 0 to 3650', async () => {
			const am = seedRealm(db, 'AM');
			seedLabour(db, { realmId: am.id });
			const client = await connect();

			for (const within_days of [0, -1, 3651]) {
				const error = await fail(client, {
					weights: NEUTRAL,
					filter: { include_closed: { within_days } }
				});
				expect(error.code, String(within_days)).toBe('invalid');
			}
		});

		it('takes has, labels, quest and unblocked', async () => {
			const am = seedRealm(db, 'AM');
			defineAttribute(db, actor, am.id, {
				key: 'area',
				kind: 'tags',
				label: 'Area',
				rubric: 'rubric',
				spec: {
					members: [
						{ key: 'ui', label: 'UI' },
						{ key: 'api', label: 'API' }
					]
				}
			});
			const a = seedLabour(db, { realmId: am.id, labels: ['bug'] });
			const b = seedLabour(db, { realmId: am.id, labels: ['bug', 'ui'] });
			const c = seedLabour(db, { realmId: am.id });
			setValues(db, actor, a.id, { area: ['ui'] });
			setValues(db, actor, b.id, { area: ['api'] });
			const quest = createQuest(db, actor, {
				realmId: anyRealmId(db),
				name: 'Q',
				ownerId: actor.id
			});
			addQuestLabours(db, actor, quest.id, [c.id, b.id]);
			appraise(db, actor, [{ labourId: a.id, links: [{ type: 'blocks', to: b.id }] }]);
			const client = await connect();

			const has = await ok(client, { weights: NEUTRAL, filter: { has: ['area:ui'] } });
			const labels = await ok(client, { weights: NEUTRAL, filter: { labels: ['BUG', 'ui'] } });
			const inQuest = await ok(client, { weights: NEUTRAL, filter: { quest: quest.id } });
			const free = await ok(client, { weights: NEUTRAL, filter: { unblocked: true } });

			expect(keys(has)).toEqual(['AM-1']);
			expect(keys(labels)).toEqual(['AM-2']);
			expect(keys(inQuest)).toEqual(['AM-2', 'AM-3']);
			expect(keys(free)).toEqual(['AM-1', 'AM-3']);
		});

		it('answers not_found for an unknown Quest', async () => {
			const am = seedRealm(db, 'AM');
			seedLabour(db, { realmId: am.id });

			const error = await fail(await connect(), { weights: NEUTRAL, filter: { quest: 9999 } });

			expect(error.code).toBe('not_found');
		});
	});

	describe('arguments', () => {
		beforeEach(() => {
			const am = seedRealm(db, 'AM');
			seedLabour(db, { realmId: am.id });
		});

		it('refuses an unknown argument, naming it', async () => {
			const error = await fail(await connect(), { weights: NEUTRAL, verbose: true });

			expect(error.code).toBe('invalid');
			expect(error.message).toContain('"verbose"');
		});

		it('refuses an unknown argument inside filter, naming its path', async () => {
			const error = await fail(await connect(), {
				weights: NEUTRAL,
				filter: { unblocked: true, bogus: 1 }
			});

			expect(error.code).toBe('invalid');
			expect(error.message).toContain('"filter.bogus"');
		});

		it('refuses an unknown argument inside include_closed', async () => {
			const error = await fail(await connect(), {
				weights: NEUTRAL,
				filter: { include_closed: { within_days: 3, bogus: 1 } }
			});

			expect(error.code).toBe('invalid');
		});

		it('refuses the domain spelling of an argument', async () => {
			const client = await connect();

			expect((await fail(client, { weights: NEUTRAL, realmIds: [1] })).code).toBe('invalid');
			expect((await fail(client, { weights: NEUTRAL, filter: { includeClosed: true } })).code).toBe(
				'invalid'
			);
			expect((await fail(client, { weights: NEUTRAL, filter: { assigneeIds: [1] } })).code).toBe(
				'invalid'
			);
		});

		it('requires weights', async () => {
			const error = await fail(await connect(), { query: 'boss' });

			expect(error.code).toBe('invalid');
			expect(error.message).toContain('weights');
		});

		it.each([
			['no weights', { weights: {} }],
			['a weight above 10', { weights: { age: 11 } }],
			['a weight below -10', { weights: { age: -11 } }],
			['a weight that is not a number', { weights: { age: 'high' } }],
			['weights that are not an object', { weights: ['age'] }],
			['an uppercase key', { weights: { Age: 1 } }],
			['a temperature above 2', { weights: NEUTRAL, temperature: 3 }],
			['a negative temperature', { weights: NEUTRAL, temperature: -1 }],
			['a limit of 0', { weights: NEUTRAL, limit: 0 }],
			['a limit of 51', { weights: NEUTRAL, limit: 51 }],
			['a fractional limit', { weights: NEUTRAL, limit: 2.5 }],
			['17 show keys', { weights: NEUTRAL, show: Array.from({ length: 17 }, (_, i) => `a${i}`) }],
			['a bare has key', { weights: NEUTRAL, filter: { has: ['area'] } }],
			['a 501-character query', { weights: NEUTRAL, query: 'a'.repeat(501) }]
		])('refuses %s as invalid', async (_name, args) => {
			const error = await fail(await connect(), args as Record<string, unknown>);

			expect(error.code).toBe('invalid');
			expect(db.select().from(surveys).all()).toHaveLength(0);
		});
	});

	describe('weights, show and the rest of the output', () => {
		function fixture() {
			const am = seedRealm(db, 'AM');
			const bl = seedRealm(db, 'BL');
			defineAttribute(db, actor, am.id, {
				key: 'impact',
				kind: 'scale',
				label: 'Impact',
				rubric: 'rubric',
				spec: { min: 0, max: 4 }
			});
			defineAttribute(db, actor, am.id, {
				key: 'area',
				kind: 'tags',
				label: 'Area',
				rubric: 'rubric',
				spec: { members: [{ key: 'ui', label: 'UI' }] }
			});
			const a = seedLabour(db, { realmId: am.id, title: 'Boss HP bar' });
			const b = seedLabour(db, { realmId: bl.id, title: 'Arena redesign' });
			setValues(db, actor, a.id, { impact: 2, area: ['ui'] });
			return { am, bl, a, b };
		}

		it('lists ignored weight and show keys, weights first', async () => {
			fixture();

			const survey = await ok(await connect(), {
				weights: { ghost: 1, impact: 1, similarity: 1 },
				show: ['nope', 'impact']
			});

			expect(survey.ignored).toEqual(['ghost', 'similarity', 'nope']);
		});

		it('gives values only when show is given, as readValues gives them', async () => {
			fixture();
			const client = await connect();

			const plain = await ok(client, { weights: NEUTRAL });
			const shown = await ok(client, { weights: NEUTRAL, show: ['impact', 'area'] });

			for (const item of plain.results) expect(item).not.toHaveProperty('values');
			expect(shown.results.map((r: any) => r.values)).toEqual([{ impact: 2, area: ['ui'] }, {}]);
		});

		it('reports coverage and missing data', async () => {
			fixture();

			const survey = await ok(await connect(), { weights: { impact: 2 }, temperature: 0 });

			expect(survey.coverage).toEqual({
				candidates: 2,
				unappraised: 2,
				stale: 0,
				unembedded: 2,
				missing: { impact: 1 }
			});
			expect(survey.results.map((r: any) => [r.key, r.score])).toEqual([
				['AM-1', 1],
				['BL-1', 1]
			]);
			expect(survey.results[0].contributions).toEqual({ impact: 1 });
		});

		it('matches a query through the keywords weight', async () => {
			fixture();
			const client = await connect();

			const withQuery = await ok(client, {
				weights: { keywords: 1 },
				query: 'boss',
				temperature: 0
			});
			const without = await ok(client, { weights: { keywords: 1 }, temperature: 0 });

			expect(withQuery.ignored).toEqual([]);
			expect(withQuery.results.map((r: any) => [r.key, r.score])).toEqual([
				['AM-1', 1],
				['BL-1', 0]
			]);
			expect(without.ignored).toEqual(['keywords']);
		});

		it('honours temperature and limit', async () => {
			const am = seedRealm(db, 'AM');
			for (let i = 0; i < 4; i++) seedLabour(db, { realmId: am.id });
			const client = await connect();

			const cut = await ok(client, { weights: NEUTRAL, temperature: 0, limit: 2 });
			const hot = await ok(client, { weights: NEUTRAL, temperature: 2, limit: 3 });

			expect(keys(cut)).toEqual(['AM-1', 'AM-2']);
			expect(cut.coverage.candidates).toBe(4);
			expect(hot.results).toHaveLength(3);
			const stored = db.select().from(surveys).all();
			expect(json(stored[0].request)).toMatchObject({ temperature: 0, limit: 2 });
			expect(json(stored[1].request)).toMatchObject({ temperature: 2, limit: 3 });
		});
	});
});
