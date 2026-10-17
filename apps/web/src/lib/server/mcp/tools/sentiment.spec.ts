import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineAttribute, setValues } from '#lib/server/agent/attributes.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { events, pulses } from '#lib/server/db/schema.ts';
import { deleteLabour, moveLabour } from '#lib/server/domain/labours.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { createMcpServer } from '../server.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-06-15T12:00:00.000Z');
const LATER = new Date(T0.getTime() + 14 * DAY);

let db: Db;
let admin: AuthUser;
let bob: AuthUser;
let root: Client;
let bobClient: Client;
let labourId: number;
const clients: Client[] = [];

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
	bob = seedHuman(db, 'bob');
	root = await connect(admin);
	bobClient = await connect(bob);

	const realm = seedRealm(db, 'AM');
	define(realm.id, 'perf', 'scale', { min: 0, max: 4 });
	define(realm.id, 'bugs', 'tags', {
		members: [
			{ key: 'crash', label: 'Crash' },
			{ key: 'lag', label: 'Lag' }
		]
	});
	labourId = seedLabour(db, { realmId: realm.id }).id;

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

function define(
	realmId: number,
	key: string,
	kind: 'scale' | 'tags',
	spec: Parameters<typeof defineAttribute>[3]['spec']
) {
	defineAttribute(db, admin, realmId, { key, kind, label: key, rubric: `About ${key}`, spec }, T0);
}

async function connect(actor: AuthUser): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor).connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

async function refused(client: Client, name: string, args: Record<string, unknown>) {
	const result = await call(client, name, args);
	expect(result.isError, `${name} should be refused`).toBe(true);
	return {
		code: (result.structuredContent as any).error.code as string,
		message: (result.structuredContent as any).error.message as string
	};
}

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

const iso = (date: Date) => date.toISOString();
const rows = () => db.select().from(pulses).all();

const pulse = (key: string, extra: Record<string, unknown> = {}) => ({
	key,
	amount: 1,
	mood: 0,
	...extra
});

async function post(client: Client, items: Record<string, unknown>[], realm = 'AM') {
	const out = await ok(client, 'pulse', { realm, pulses: items });
	return out.pulses as { index: number; status: string; id: number }[];
}

describe('tool listing', () => {
	it('lists the four tools with closed input schemas and the right kind', async () => {
		const { tools } = await root.listTools();
		const byName = new Map(tools.map((tool) => [tool.name, tool]));

		for (const name of ['pulse', 'get_sentiment', 'file_pulses', 'delete_pulse']) {
			const tool = byName.get(name);
			expect(tool, name).toBeDefined();
			expect(tool!.description, name).toBeTruthy();
			expect(tool!.inputSchema.additionalProperties, name).toBe(false);
		}
		expect(byName.get('get_sentiment')!.annotations).toMatchObject({ readOnlyHint: true });
		expect(byName.get('pulse')!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		expect(byName.get('file_pulses')!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		expect(byName.get('delete_pulse')!.annotations).toMatchObject({ destructiveHint: true });
	});
});

describe('pulse', () => {
	it('posts a batch and reports each item by index, status and id', async () => {
		const out = await ok(root, 'pulse', {
			realm: 'am',
			pulses: [
				pulse('perf', {
					amount: 2,
					mood: -0.5,
					note: 'slow',
					evidence: [{ href: 'https://x.test/1', label: 'thread' }, { labour: 'AM-1' }],
					half_life_days: 7,
					ref: 'r1'
				}),
				pulse('ghost')
			]
		});

		expect(out).toEqual({
			pulses: [
				{ index: 0, status: 'filed', id: expect.any(Number) },
				{ index: 1, status: 'unfiled', id: expect.any(Number) }
			]
		});
		const [first, second] = rows();
		expect(first).toMatchObject({
			id: out.pulses[0].id,
			rawKey: 'perf',
			amount: 2,
			mood: -0.5,
			note: 'slow',
			halfLifeDays: 7,
			ref: 'r1',
			authorId: admin.id
		});
		expect(second).toMatchObject({ id: out.pulses[1].id, halfLifeDays: 14 });
	});

	it('takes the Realm in any case', async () => {
		const out = await post(root, [pulse('perf')], 'Am');

		expect(out[0].status).toBe('filed');
	});

	it('posts as the User of the token', async () => {
		await post(bobClient, [pulse('perf')]);

		expect(rows()[0].authorId).toBe(bob.id);
	});

	it('skips an item whose ref the author already used with the key', async () => {
		const [first] = await post(root, [pulse('perf', { ref: 'r1' })]);

		const [again] = await post(root, [pulse('perf', { ref: 'r1' })]);

		expect(again).toEqual({ index: 0, status: 'skipped', id: first.id });
		expect(rows()).toHaveLength(1);
	});

	it('never fades a Pulse posted with half_life_days: null', async () => {
		await post(root, [
			pulse('perf', { amount: 2, half_life_days: null }),
			pulse('bugs:lag', { amount: 2, half_life_days: 7 })
		]);
		vi.setSystemTime(new Date(T0.getTime() + 100 * DAY));

		const out = await ok(root, 'get_sentiment', { realm: 'AM' });

		const weight = (key: string) => out.keys.find((k: any) => k.key === key).pulses[0].weight;
		expect(rows().map((row) => row.halfLifeDays)).toEqual([null, 7]);
		expect(weight('perf')).toBe(2);
		expect(weight('bugs:lag')).toBeCloseTo(2 * 2 ** (-100 / 7), 10);
	});

	it('names Labours in evidence by key in any case, a former key included', async () => {
		const other = seedRealm(db, 'BL');
		await post(root, [pulse('perf', { evidence: [{ labour: 'am-1' }] })]);
		moveLabour(db, admin, labourId, { realmId: other.id });
		await post(root, [pulse('bugs:lag', { evidence: [{ labour: 'AM-1' }] })]);

		const out = await ok(root, 'get_sentiment', { realm: 'AM' });

		expect(out.keys.map((k: any) => k.pulses[0].evidence)).toEqual([
			[{ labour: 'BL-1' }],
			[{ labour: 'BL-1' }]
		]);
	});

	it.each([
		['at the top level', { bogus: 1 }, {}],
		['in a Pulse', {}, { bogus: 1 }],
		['in a Pulse as the camelCase of a known one', {}, { halfLifeDays: 7 }],
		['in evidence', {}, { evidence: [{ href: 'https://a.test', bogus: 1 }] }],
		['in labour evidence', {}, { evidence: [{ labour: 'AM-1', bogus: 1 }] }]
	])('refuses an unknown argument %s and writes nothing', async (_name, top, nested) => {
		const { code } = await refused(root, 'pulse', {
			realm: 'AM',
			pulses: [pulse('perf', nested)],
			...top
		});

		expect(code).toBe('invalid');
		expect(rows()).toEqual([]);
	});

	it('names the unknown nested argument it refused', async () => {
		const { message } = await refused(root, 'pulse', {
			realm: 'AM',
			pulses: [pulse('perf'), pulse('perf', { bogus: 1 })]
		});

		expect(message).toContain('pulses.1.bogus');
	});

	it.each([
		['an empty batch', []],
		['51 items', Array.from({ length: 51 }, (_, i) => pulse('perf', { ref: `r${i}` }))],
		['an amount of 0', [pulse('perf', { amount: 0 })]],
		['an amount above 10', [pulse('perf', { amount: 11 })]],
		['a mood above 1', [pulse('perf', { mood: 1.5 })]],
		['a malformed key', [pulse('Bad Key')]],
		['a half-life of 0', [pulse('perf', { half_life_days: 0 })]],
		['a half-life above 365', [pulse('perf', { half_life_days: 366 })]],
		['a note over 1,000 characters', [pulse('perf', { note: 'n'.repeat(1001) })]],
		['an empty ref', [pulse('perf', { ref: '' })]],
		['an amount given as a string', [pulse('perf', { amount: '2' })]]
	])('refuses %s as invalid and writes nothing', async (_name, items) => {
		const { code } = await refused(root, 'pulse', { realm: 'AM', pulses: items });

		expect(code).toBe('invalid');
		expect(rows()).toEqual([]);
	});

	it('refuses the whole batch when one item is invalid', async () => {
		const { code } = await refused(root, 'pulse', {
			realm: 'AM',
			pulses: [pulse('perf'), pulse('perf', { amount: 0 })]
		});

		expect(code).toBe('invalid');
		expect(rows()).toEqual([]);
	});

	it('refuses evidence naming a Labour that does not exist as not_found', async () => {
		const { code } = await refused(root, 'pulse', {
			realm: 'AM',
			pulses: [pulse('perf'), pulse('perf', { evidence: [{ labour: 'AM-99' }] })]
		});

		expect(code).toBe('not_found');
		expect(rows()).toEqual([]);
	});

	it('refuses an unknown Realm as not_found', async () => {
		const { code } = await refused(root, 'pulse', { realm: 'ZZ', pulses: [pulse('perf')] });

		expect(code).toBe('not_found');
	});

	it('refuses a call without a Realm or Pulses', async () => {
		expect((await refused(root, 'pulse', { pulses: [pulse('perf')] })).code).toBe('invalid');
		expect((await refused(root, 'pulse', { realm: 'AM' })).code).toBe('invalid');
	});

	it('records no Event', async () => {
		const before = db.select().from(events).all();

		await post(root, [pulse('perf'), pulse('ghost')]);

		expect(db.select().from(events).all()).toEqual(before);
	});
});

describe('get_sentiment', () => {
	it('shows each key with its Pulses, authors by username and dates as ISO strings', async () => {
		const [mine] = await post(root, [
			pulse('perf', {
				amount: 2,
				mood: -1,
				note: 'slow',
				evidence: [
					{ href: 'https://x.test', label: 'thread' },
					{ href: 'https://y.test' },
					{ labour: 'AM-1' }
				]
			})
		]);
		const [theirs] = await post(bobClient, [pulse('perf', { amount: 4, mood: 1, note: 'fast' })]);
		const [ghost] = await post(root, [pulse('ghost', { note: 'who knows' })]);
		vi.setSystemTime(LATER);

		const out = await ok(root, 'get_sentiment', { realm: 'AM' });

		expect(out).toEqual({
			asOf: iso(LATER),
			keys: [
				{
					realm: 'AM',
					key: 'perf',
					volume: 3,
					mood: expect.closeTo(1 / 3, 10),
					v: 0.375,
					pulses: [
						{
							id: theirs.id,
							note: 'fast',
							evidence: [],
							author: 'bob',
							createdAt: iso(T0),
							weight: 2
						},
						{
							id: mine.id,
							note: 'slow',
							evidence: [
								{ href: 'https://x.test', label: 'thread' },
								{ href: 'https://y.test', label: null },
								{ labour: 'AM-1' }
							],
							author: 'root',
							createdAt: iso(T0),
							weight: 1
						}
					]
				}
			],
			unfiled: [
				{ rawKey: 'ghost', volume: 0.5, count: 1, newest: { id: ghost.id, note: 'who knows' } }
			]
		});
	});

	it('is empty for a Realm without Pulses', async () => {
		expect(await ok(root, 'get_sentiment', { realm: 'AM' })).toEqual({
			asOf: iso(T0),
			keys: [],
			unfiled: []
		});
	});

	it('lists three Pulses per key by default and as many as limit asks', async () => {
		await post(
			root,
			Array.from({ length: 5 }, (_, i) => pulse('perf', { amount: i + 1, ref: `r${i}` }))
		);

		const byDefault = await ok(root, 'get_sentiment', { realm: 'AM' });
		const one = await ok(root, 'get_sentiment', { realm: 'AM', limit: 1 });
		const all = await ok(root, 'get_sentiment', { realm: 'AM', limit: 20 });

		expect(byDefault.keys[0].pulses.map((p: any) => p.weight)).toEqual([5, 4, 3]);
		expect(one.keys[0].pulses).toHaveLength(1);
		expect(all.keys[0].pulses).toHaveLength(5);
		expect(one.keys[0].volume).toBe(15);
	});

	it.each([0, 21, 1.5])('refuses a limit of %s', async (limit) => {
		expect((await refused(root, 'get_sentiment', { realm: 'AM', limit })).code).toBe('invalid');
	});

	it('shows evidence naming a Labour by its current key after the Labour moves', async () => {
		const other = seedRealm(db, 'BL');
		await post(root, [pulse('perf', { evidence: [{ labour: 'AM-1' }] })]);

		moveLabour(db, admin, labourId, { realmId: other.id });

		const out = await ok(root, 'get_sentiment', { realm: 'AM' });
		expect(out.keys[0].pulses[0].evidence).toEqual([{ labour: 'BL-1' }]);
	});

	it('leaves out evidence naming a deleted Labour', async () => {
		const gone = seedLabour(db, { realmId: seedRealm(db, 'BL').id });
		await post(root, [
			pulse('perf', {
				evidence: [{ labour: 'BL-1' }, { href: 'https://a.test' }, { labour: 'AM-1' }]
			})
		]);

		deleteLabour(db, admin, gone.id);

		const out = await ok(root, 'get_sentiment', { realm: 'AM' });
		expect(out.keys[0].pulses[0].evidence).toEqual([
			{ href: 'https://a.test', label: null },
			{ labour: 'AM-1' }
		]);
	});

	it('refuses an unknown argument and an unknown Realm', async () => {
		expect((await refused(root, 'get_sentiment', { realm: 'AM', bogus: 1 })).code).toBe('invalid');
		expect((await refused(root, 'get_sentiment', { realm: 'ZZ' })).code).toBe('not_found');
	});
});

describe('file_pulses', () => {
	it('files the unfiled Pulses of a raw key under a key and reports how many', async () => {
		await post(root, [pulse('slow'), pulse('slow', { amount: 2 }), pulse('other')]);

		const out = await ok(root, 'file_pulses', { realm: 'am', raw_key: 'slow', key: 'perf' });

		expect(out).toEqual({ filed: 2 });
		const view = await ok(root, 'get_sentiment', { realm: 'AM' });
		expect(view.keys.map((k: any) => [k.key, k.volume])).toEqual([['perf', 3]]);
		expect(view.unfiled.map((entry: any) => entry.rawKey)).toEqual(['other']);
	});

	it('files under a member of a tags Attribute', async () => {
		await post(root, [pulse('crashes')]);

		await ok(root, 'file_pulses', { realm: 'AM', raw_key: 'crashes', key: 'bugs:crash' });

		const view = await ok(root, 'get_sentiment', { realm: 'AM' });
		expect(view.keys.map((k: any) => k.key)).toEqual(['bugs:crash']);
	});

	it('reports 0 when nothing matches', async () => {
		expect(await ok(root, 'file_pulses', { realm: 'AM', raw_key: 'none', key: 'perf' })).toEqual({
			filed: 0
		});
	});

	it('refuses a key the Realm cannot file under, moving nothing', async () => {
		await post(root, [pulse('slow')]);

		for (const key of ['ghost', 'bugs', 'perf:high']) {
			expect((await refused(root, 'file_pulses', { realm: 'AM', raw_key: 'slow', key })).code).toBe(
				'invalid'
			);
		}
		expect(rows()[0].attributeId).toBeNull();
	});

	it('refuses an unknown argument, a camelCase one and a missing one', async () => {
		const args = { realm: 'AM', raw_key: 'slow', key: 'perf' };

		expect((await refused(root, 'file_pulses', { ...args, bogus: 1 })).code).toBe('invalid');
		expect(
			(await refused(root, 'file_pulses', { realm: 'AM', rawKey: 'slow', key: 'perf' })).code
		).toBe('invalid');
		expect((await refused(root, 'file_pulses', { realm: 'AM', key: 'perf' })).code).toBe('invalid');
	});

	it('refuses an unknown Realm as not_found', async () => {
		const out = await refused(root, 'file_pulses', { realm: 'ZZ', raw_key: 'slow', key: 'perf' });

		expect(out.code).toBe('not_found');
	});
});

describe('delete_pulse', () => {
	it('deletes the Pulse, whoever wrote it', async () => {
		const [mine] = await post(root, [pulse('perf')]);
		const [theirs] = await post(root, [pulse('perf', { note: 'kept' })]);

		const out = await ok(bobClient, 'delete_pulse', { pulse: mine.id });

		expect(out).toEqual({ deleted: { id: mine.id } });
		expect(rows().map((row) => row.id)).toEqual([theirs.id]);
		const view = await ok(root, 'get_sentiment', { realm: 'AM' });
		expect(view.keys[0].pulses.map((p: any) => p.id)).toEqual([theirs.id]);
	});

	it('refuses an unknown id as not_found', async () => {
		expect((await refused(root, 'delete_pulse', { pulse: 9999 })).code).toBe('not_found');
	});

	it('refuses an id given as a string, and unknown arguments', async () => {
		const [made] = await post(root, [pulse('perf')]);

		expect((await refused(root, 'delete_pulse', { pulse: String(made.id) })).code).toBe('invalid');
		expect((await refused(root, 'delete_pulse', { pulse: made.id, bogus: 1 })).code).toBe(
			'invalid'
		);
		expect(rows()).toHaveLength(1);
	});
});

describe('survey', () => {
	beforeEach(() => {
		setValues(db, admin, labourId, { perf: 4 }, T0);
	});

	it('shows the keys behind the sentiment features, authors by username and no weight', async () => {
		const [mine] = await post(root, [
			pulse('perf', {
				amount: 2,
				mood: -1,
				note: 'slow',
				evidence: [{ labour: 'AM-1' }, { href: 'https://x.test', label: 'thread' }]
			})
		]);

		const out = await ok(root, 'survey', { realm: 'AM', weights: { sentiment: 1 } });

		expect(out.results.map((r: any) => r.key)).toEqual(['AM-1']);
		expect(out.sentiment).toEqual([
			{
				realm: 'AM',
				key: 'perf',
				volume: 2,
				mood: -1,
				pulses: [
					{
						id: mine.id,
						note: 'slow',
						evidence: [{ labour: 'AM-1' }, { href: 'https://x.test', label: 'thread' }],
						author: 'root',
						createdAt: iso(T0)
					}
				]
			}
		]);
	});

	it.each(['pain', 'delight'])('fills the block when %s is weighted', async (name) => {
		await post(root, [pulse('perf', { mood: name === 'pain' ? -1 : 1 })]);

		const out = await ok(root, 'survey', { realm: 'AM', weights: { [name]: 1 } });

		expect(out.sentiment.map((entry: any) => entry.key)).toEqual(['perf']);
		expect(out.results[0].score).toBeGreaterThan(0);
	});

	it('shows the two heaviest Pulses and the authors who wrote them', async () => {
		const [light] = await post(root, [pulse('perf', { amount: 1, note: 'light' })]);
		const [heavy] = await post(bobClient, [pulse('perf', { amount: 5, note: 'heavy' })]);
		const [middle] = await post(root, [pulse('perf', { amount: 3, note: 'middle' })]);

		const out = await ok(root, 'survey', { realm: 'AM', weights: { sentiment: 1 } });

		expect(out.sentiment[0].pulses.map((p: any) => [p.id, p.author])).toEqual([
			[heavy.id, 'bob'],
			[middle.id, 'root']
		]);
		expect(out.sentiment[0].pulses.map((p: any) => p.id)).not.toContain(light.id);
	});

	it('shows evidence by the current key of a Labour that moved', async () => {
		const evidence = seedLabour(db, { realmId: seedRealm(db, 'ZZ').id });
		await post(root, [pulse('perf', { evidence: [{ labour: 'ZZ-1' }] })]);
		moveLabour(db, admin, evidence.id, { realmId: seedRealm(db, 'BL').id });

		const out = await ok(root, 'survey', { realm: 'AM', weights: { sentiment: 1 } });

		expect(out.sentiment[0].pulses[0].evidence).toEqual([{ labour: 'BL-1' }]);
	});

	it('is empty when no sentiment feature is weighted', async () => {
		await post(root, [pulse('perf', { amount: 2 })]);

		const out = await ok(root, 'survey', { realm: 'AM', weights: { perf: 1 } });

		expect(out.sentiment).toEqual([]);
	});
});
