import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineAttribute, readValues, setValues } from '#lib/server/agent/attributes.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createMcpServer } from '../server.ts';

let db: Db;
let admin: AuthUser;
let client: Client;
const clients: Client[] = [];

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
	client = await connect(admin);
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((c) => c.close()));
	db.$client.close();
});

async function connect(actor: AuthUser): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor, 'http://sagas.test').connect(serverSide);
	const connected = new Client({ name: 'spec', version: '0' });
	await connected.connect(clientSide);
	clients.push(connected);
	return connected;
}

async function call(name: string, args: Record<string, unknown> = {}) {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

async function ok(name: string, args: Record<string, unknown> = {}) {
	const result = await call(name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

async function refused(name: string, args: Record<string, unknown>, code: string) {
	const result = await call(name, args);
	expect(result.isError, `${name} should be refused`).toBe(true);
	expect(result.structuredContent).toMatchObject({ error: { code } });
	return result;
}

const lastSeq = () => eventWindow(db).last;

async function seedRealm(labourCount = 0): Promise<number[]> {
	await ok('create_realm', { name: 'Atlas', key: 'am' });
	const ids: number[] = [];
	for (let i = 1; i <= labourCount; i++) {
		ids.push((await ok('create_labour', { realm: 'AM', title: `Labour ${i}` })).labour.id);
	}
	return ids;
}

const realmId = async () => (await ok('get_realm', { realm: 'AM' })).realm.id as number;

const QUALITY = {
	realm: 'AM',
	key: 'quality',
	kind: 'scale',
	label: 'Quality',
	rubric: 'How good it is',
	spec: { min: 1, max: 5 }
};

const AREA = {
	realm: 'AM',
	key: 'area',
	kind: 'tags',
	label: 'Area',
	rubric: 'Which part of the game',
	spec: {
		members: [
			{ key: 'art', label: 'Art', rubric: 'Visuals' },
			{ key: 'code', label: 'Code' }
		]
	}
};

const NOTE = { realm: 'AM', key: 'note', kind: 'text', label: 'Note', rubric: 'Free text' };

const PAST = new Date(Date.now() - 3_600_000);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the attribute tools in the tool list', () => {
	it('lists the four tools with a description and a closed input schema', async () => {
		const { tools } = await client.listTools();

		for (const name of ['get_attributes', 'define_attribute', 'delete_attribute', 'tune_realm']) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(tool!.description, name).toBeTruthy();
			expect(tool!.inputSchema.type, name).toBe('object');
			expect(tool!.inputSchema.additionalProperties, name).toBe(false);
		}
	});

	it('marks get_attributes read-only, delete_attribute destructive, the others plain writes', async () => {
		const { tools } = await client.listTools();
		const annotations = (name: string) => tools.find((t) => t.name === name)!.annotations;

		expect(annotations('get_attributes')).toMatchObject({ readOnlyHint: true });
		expect(annotations('define_attribute')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		expect(annotations('tune_realm')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		expect(annotations('delete_attribute')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true
		});
	});
});

describe('get_attributes', () => {
	it('reads a fresh Realm: version 0, no notes, default settings, no Attributes', async () => {
		await seedRealm();

		const result = await ok('get_attributes', { realm: 'AM' });

		expect(result).toEqual({
			realm: 'AM',
			version: 0,
			notes: '',
			settings: { halfLifeDays: 14, loudness: 5 },
			attributes: []
		});
	});

	it('lists Attributes in position order with exactly the Attribute fields', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);
		await ok('define_attribute', NOTE);
		await ok('define_attribute', AREA);

		const result = await ok('get_attributes', { realm: 'AM' });

		expect(result.attributes.map((a: any) => [a.key, a.position])).toEqual([
			['quality', 0],
			['note', 1],
			['area', 2]
		]);
		for (const attribute of result.attributes) {
			expect(Object.keys(attribute).sort()).toEqual(
				[
					'counts',
					'held',
					'key',
					'kind',
					'label',
					'position',
					'revisedAt',
					'rubric',
					'spec',
					'stale'
				].sort()
			);
			expect(attribute.revisedAt).toMatch(ISO);
		}
		expect(result.attributes[0]).toMatchObject({
			kind: 'scale',
			label: 'Quality',
			rubric: 'How good it is',
			spec: { min: 1, max: 5 },
			held: 0,
			stale: 0,
			counts: {}
		});
		expect(result.attributes[1]).toMatchObject({ kind: 'text', spec: { max: 2000 }, counts: {} });
		expect(result.attributes[2]).toMatchObject({
			kind: 'tags',
			spec: {
				members: [
					{ key: 'art', label: 'Art', rubric: 'Visuals' },
					{ key: 'code', label: 'Code', rubric: '' }
				],
				max: null
			},
			counts: { art: 0, code: 0 }
		});
	});

	it('reports held, stale and counts for the values Labours hold', async () => {
		const [one, two, three] = await seedRealm(3);
		await ok('define_attribute', QUALITY);
		await ok('define_attribute', AREA);
		await ok('define_attribute', NOTE);
		setValues(db, admin, one, { quality: 3, area: ['art', 'code'], note: 'hi' });
		setValues(db, admin, two, { quality: 3, area: ['code'] });
		setValues(db, admin, three, { quality: 5 });

		const { attributes } = await ok('get_attributes', { realm: 'AM' });
		const by = (key: string) => attributes.find((a: any) => a.key === key);

		expect(by('quality')).toMatchObject({ held: 3, stale: 0, counts: { '3': 2, '5': 1 } });
		expect(by('area')).toMatchObject({ held: 2, counts: { art: 1, code: 2 } });
		expect(by('note')).toMatchObject({ held: 1, counts: {} });
	});

	it('counts a value as stale once its Attribute rubric is revised', async () => {
		const [labour] = await seedRealm(1);
		await ok('define_attribute', QUALITY);
		setValues(db, admin, labour, { quality: 3 }, PAST);

		await ok('define_attribute', { realm: 'AM', key: 'quality', kind: 'scale', rubric: 'Sharper' });

		const { attributes } = await ok('get_attributes', { realm: 'AM' });
		expect(attributes[0]).toMatchObject({ held: 1, stale: 1 });
	});

	it('answers with only realm and version when since equals the current version', async () => {
		await seedRealm();
		const { version } = await ok('define_attribute', QUALITY);

		const result = await ok('get_attributes', { realm: 'AM', since: version });

		expect(result).toEqual({ realm: 'AM', version });
	});

	it('answers a fresh Realm with since 0 as realm and version only', async () => {
		await seedRealm();

		expect(await ok('get_attributes', { realm: 'AM', since: 0 })).toEqual({
			realm: 'AM',
			version: 0
		});
	});

	it('answers in full when since is behind the current version', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);
		const { version } = await ok('define_attribute', NOTE);

		const result = await ok('get_attributes', { realm: 'AM', since: version - 1 });

		expect(result).toMatchObject({ realm: 'AM', version, notes: '' });
		expect(result.attributes).toHaveLength(2);
		expect(result.settings).toEqual({ halfLifeDays: 14, loudness: 5 });
	});

	it('answers in full when since is ahead of the current version', async () => {
		await seedRealm();

		const result = await ok('get_attributes', { realm: 'AM', since: 99 });

		expect(result).toMatchObject({ version: 0, attributes: [] });
	});

	it('answers in full once a write has moved the version past since', async () => {
		await seedRealm();
		const first = await ok('tune_realm', { realm: 'AM', notes: 'one' });
		expect(await ok('get_attributes', { realm: 'AM', since: first.version })).toEqual({
			realm: 'AM',
			version: first.version
		});

		await ok('tune_realm', { realm: 'AM', notes: 'two' });

		const result = await ok('get_attributes', { realm: 'AM', since: first.version });
		expect(result).toMatchObject({ version: first.version + 1, notes: 'two' });
	});

	it('reflects tune_realm in notes and settings', async () => {
		await seedRealm();
		await ok('tune_realm', {
			realm: 'AM',
			notes: 'Prefer players',
			half_life_days: 30,
			loudness: 8
		});

		const result = await ok('get_attributes', { realm: 'AM' });

		expect(result).toMatchObject({
			notes: 'Prefer players',
			settings: { halfLifeDays: 30, loudness: 8 }
		});
	});

	it.each([-1, 1.5, '2', null])('refuses since %j as invalid', async (since) => {
		await seedRealm();

		await refused('get_attributes', { realm: 'AM', since }, 'invalid');
	});

	it('names the Realm by its current key whatever key or id the call used', async () => {
		await seedRealm();
		const id = await realmId();
		await ok('rename_realm_key', { realm: 'AM', key: 'ZZ' });

		for (const realm of ['ZZ', 'zz', 'AM', 'am', id]) {
			const result = await ok('get_attributes', { realm });
			expect(result.realm, String(realm)).toBe('ZZ');
		}
	});

	it('refuses an unknown Realm with not_found', async () => {
		await refused('get_attributes', { realm: 'NOPE' }, 'not_found');
	});

	it('requires realm', async () => {
		await refused('get_attributes', {}, 'invalid');
	});

	it('refuses an unknown argument, naming it', async () => {
		await seedRealm();

		const result = await refused('get_attributes', { realm: 'AM', verbose: true }, 'invalid');

		expect(text(result)).toContain('unknown argument "verbose"');
	});
});

describe('define_attribute', () => {
	it('creates a scale Attribute and returns the new version and the Attribute', async () => {
		await seedRealm();

		const result = await ok('define_attribute', QUALITY);

		expect(result).toEqual({
			version: 1,
			attribute: {
				key: 'quality',
				kind: 'scale',
				label: 'Quality',
				rubric: 'How good it is',
				spec: { min: 1, max: 5 },
				position: 0,
				revisedAt: expect.stringMatching(ISO),
				held: 0,
				stale: 0,
				counts: {}
			}
		});
	});

	it('creates tags and text Attributes with normalized specs', async () => {
		await seedRealm();

		const tagged = await ok('define_attribute', AREA);
		const free = await ok('define_attribute', NOTE);

		expect(tagged.attribute.spec).toEqual({
			members: [
				{ key: 'art', label: 'Art', rubric: 'Visuals' },
				{ key: 'code', label: 'Code', rubric: '' }
			],
			max: null
		});
		expect(tagged.attribute.counts).toEqual({ art: 0, code: 0 });
		expect(free.attribute.spec).toEqual({ max: 2000 });
		expect([tagged.version, free.version]).toEqual([1, 2]);
	});

	it('accepts the Realm as a lowercase key or as an id', async () => {
		await seedRealm();
		const id = await realmId();

		await ok('define_attribute', { ...QUALITY, realm: 'am' });
		const result = await ok('define_attribute', { ...NOTE, realm: id });

		expect(result.version).toBe(2);
	});

	it('writes into the Realm named by a former key', async () => {
		await seedRealm();
		await ok('rename_realm_key', { realm: 'AM', key: 'ZZ' });

		await ok('define_attribute', { ...QUALITY, realm: 'AM' });

		const result = await ok('get_attributes', { realm: 'ZZ' });
		expect(result.attributes.map((a: any) => a.key)).toEqual(['quality']);
	});

	it('places a new Attribute at index', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);
		await ok('define_attribute', NOTE);

		const result = await ok('define_attribute', { ...AREA, index: 0 });

		expect(result.attribute.position).toBe(0);
		const listed = await ok('get_attributes', { realm: 'AM' });
		expect(listed.attributes.map((a: any) => a.key)).toEqual(['area', 'quality', 'note']);
	});

	it('revises an existing Attribute by key and moves it with index', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);
		await ok('define_attribute', NOTE);

		const result = await ok('define_attribute', {
			realm: 'AM',
			key: 'note',
			kind: 'text',
			label: 'Renamed',
			index: 0
		});

		expect(result.version).toBe(3);
		expect(result.attribute).toMatchObject({ key: 'note', label: 'Renamed', position: 0 });
		const listed = await ok('get_attributes', { realm: 'AM' });
		expect(listed.attributes.map((a: any) => a.key)).toEqual(['note', 'quality']);
	});

	it('advances revisedAt on a rubric change and holds it on a label change', async () => {
		await seedRealm();
		const created = await ok('define_attribute', QUALITY);
		await sleep(5);

		const relabelled = await ok('define_attribute', {
			realm: 'AM',
			key: 'quality',
			kind: 'scale',
			label: 'Renamed'
		});
		expect(relabelled.attribute.revisedAt).toBe(created.attribute.revisedAt);

		const revised = await ok('define_attribute', {
			realm: 'AM',
			key: 'quality',
			kind: 'scale',
			rubric: 'A sharper rubric'
		});
		expect(new Date(revised.attribute.revisedAt).getTime()).toBeGreaterThan(
			new Date(created.attribute.revisedAt).getTime()
		);
	});

	it('returns the current version unchanged when a revise changes nothing', async () => {
		await seedRealm();
		const created = await ok('define_attribute', QUALITY);

		const again = await ok('define_attribute', QUALITY);

		expect(again.version).toBe(created.version);
		expect(again.attribute).toEqual(created.attribute);
	});

	it('returns counts and stale for a held Attribute', async () => {
		const [labour] = await seedRealm(1);
		await ok('define_attribute', QUALITY);
		setValues(db, admin, labour, { quality: 4 }, PAST);

		const result = await ok('define_attribute', {
			realm: 'AM',
			key: 'quality',
			kind: 'scale',
			rubric: 'Sharper'
		});

		expect(result.attribute).toMatchObject({ held: 1, stale: 1, counts: { '4': 1 } });
	});

	it('clamps held values when a scale is narrowed', async () => {
		const [labour] = await seedRealm(1);
		await ok('define_attribute', { ...QUALITY, spec: { min: 1, max: 10 } });
		setValues(db, admin, labour, { quality: 9 }, PAST);

		const result = await ok('define_attribute', { ...QUALITY, spec: { min: 1, max: 5 } });

		expect(result.attribute.counts).toEqual({ '5': 1 });
		expect(readValues(db, labour)[0]).toMatchObject({ value: 5 });
	});

	it('refuses lowering a max below a held value with conflict', async () => {
		const [labour] = await seedRealm(1);
		await ok('define_attribute', { ...NOTE, spec: { max: 100 } });
		setValues(db, admin, labour, { note: 'twelve chars' }, PAST);

		await refused('define_attribute', { ...NOTE, spec: { max: 5 } }, 'conflict');

		expect((await ok('get_attributes', { realm: 'AM' })).attributes[0].spec).toEqual({ max: 100 });
	});

	it('refuses the 33rd Attribute with conflict', async () => {
		await seedRealm();
		const id = await realmId();
		for (let i = 0; i < 32; i++) {
			const { realm: _realm, ...input } = { ...QUALITY, key: `attr-${i}` };
			defineAttribute(db, admin, id, input as never, PAST);
		}

		await refused('define_attribute', { ...QUALITY, key: 'one-more' }, 'conflict');
	});

	it.each(['rank', 'priority', 'skill_fit', 'activity', 'Quality', '1quality', 'a_b'])(
		'refuses the key %s as invalid',
		async (key) => {
			await seedRealm();

			await refused('define_attribute', { ...QUALITY, key }, 'invalid');
		}
	);

	it('refuses a kind change as invalid', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);

		await refused('define_attribute', { ...NOTE, key: 'quality' }, 'invalid');
	});

	it.each(['number', 'Scale', '', 3])('refuses kind %j as invalid', async (kind) => {
		await seedRealm();

		await refused('define_attribute', { ...QUALITY, kind }, 'invalid');
	});

	it('refuses a spec that does not fit the kind as invalid', async () => {
		await seedRealm();

		await refused('define_attribute', { ...QUALITY, spec: { min: 5, max: 1 } }, 'invalid');
		await refused('define_attribute', { ...QUALITY, spec: { members: [] } }, 'invalid');
		await refused(
			'define_attribute',
			{ ...QUALITY, spec: { min: 1, max: 5, members: [{ key: 'a', label: 'A' }] } },
			'invalid'
		);
		await refused('define_attribute', { ...AREA, spec: { members: [] } }, 'invalid');
		await refused('define_attribute', { ...NOTE, spec: { max: 0 } }, 'invalid');
	});

	it('refuses an unknown field inside spec as invalid', async () => {
		await seedRealm();

		await refused('define_attribute', { ...QUALITY, spec: { min: 1, max: 5, step: 1 } }, 'invalid');
	});

	it('refuses a spec with the wrong value types as invalid', async () => {
		await seedRealm();

		await refused('define_attribute', { ...QUALITY, spec: { min: '1', max: 5 } }, 'invalid');
	});

	it('refuses a missing label, rubric or spec on create as invalid', async () => {
		await seedRealm();
		const { label: _l, ...noLabel } = QUALITY;
		const { rubric: _r, ...noRubric } = QUALITY;
		const { spec: _s, ...noSpec } = QUALITY;

		await refused('define_attribute', noLabel, 'invalid');
		await refused('define_attribute', noRubric, 'invalid');
		await refused('define_attribute', noSpec, 'invalid');
	});

	it('refuses an index out of range as invalid', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);

		await refused('define_attribute', { ...NOTE, index: 2 }, 'invalid');
		await refused('define_attribute', { ...NOTE, index: -1 }, 'invalid');
		await refused('define_attribute', { ...NOTE, index: 0.5 }, 'invalid');
	});

	it('requires realm, key and kind', async () => {
		await seedRealm();
		const { realm: _a, ...noRealm } = QUALITY;
		const { key: _b, ...noKey } = QUALITY;
		const { kind: _c, ...noKind } = QUALITY;

		await refused('define_attribute', noRealm, 'invalid');
		await refused('define_attribute', noKey, 'invalid');
		await refused('define_attribute', noKind, 'invalid');
	});

	it('refuses an unknown argument, naming it', async () => {
		await seedRealm();

		const result = await refused('define_attribute', { ...QUALITY, verbose: true }, 'invalid');

		expect(text(result)).toContain('unknown argument "verbose"');
	});

	it('refuses an unknown Realm with not_found', async () => {
		await refused('define_attribute', { ...QUALITY, realm: 'NOPE' }, 'not_found');
	});

	it('records no Event', async () => {
		await seedRealm(1);
		const before = lastSeq();

		await ok('define_attribute', QUALITY);
		await ok('define_attribute', { realm: 'AM', key: 'quality', kind: 'scale', rubric: 'Again' });
		await refused('define_attribute', { ...QUALITY, key: 'rank' }, 'invalid');

		expect(lastSeq()).toBe(before);
	});
});

describe('delete_attribute', () => {
	it('deletes the Attribute and reports the version and the key', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);
		const note = await ok('define_attribute', NOTE);

		const result = await ok('delete_attribute', { realm: 'AM', key: 'quality' });

		expect(result).toEqual({ version: note.version + 1, deleted: { key: 'quality' } });
		const listed = await ok('get_attributes', { realm: 'AM' });
		expect(listed.attributes.map((a: any) => [a.key, a.position])).toEqual([['note', 0]]);
		expect(listed.version).toBe(result.version);
	});

	it('deletes the values of the Attribute', async () => {
		const [labour] = await seedRealm(1);
		await ok('define_attribute', QUALITY);
		await ok('define_attribute', NOTE);
		setValues(db, admin, labour, { quality: 2, note: 'hi' }, PAST);

		await ok('delete_attribute', { realm: 'AM', key: 'quality' });

		expect(readValues(db, labour).map((v) => v.key)).toEqual(['note']);
	});

	it('refuses an unknown key with not_found, changing nothing', async () => {
		await seedRealm();
		const created = await ok('define_attribute', QUALITY);

		await refused('delete_attribute', { realm: 'AM', key: 'nope' }, 'not_found');

		expect((await ok('get_attributes', { realm: 'AM' })).version).toBe(created.version);
	});

	it('refuses an unknown Realm with not_found', async () => {
		await refused('delete_attribute', { realm: 'NOPE', key: 'quality' }, 'not_found');
	});

	it('requires realm and key, and refuses unknown arguments', async () => {
		await seedRealm();
		await ok('define_attribute', QUALITY);

		await refused('delete_attribute', { realm: 'AM' }, 'invalid');
		await refused('delete_attribute', { key: 'quality' }, 'invalid');
		const result = await refused(
			'delete_attribute',
			{ realm: 'AM', key: 'quality', force: true },
			'invalid'
		);
		expect(text(result)).toContain('unknown argument "force"');
		expect((await ok('get_attributes', { realm: 'AM' })).attributes).toHaveLength(1);
	});

	it('records no Event', async () => {
		await seedRealm(1);
		await ok('define_attribute', QUALITY);
		const before = lastSeq();

		await ok('delete_attribute', { realm: 'AM', key: 'quality' });

		expect(lastSeq()).toBe(before);
	});
});

describe('tune_realm', () => {
	it('sets notes and both settings and returns the Realm view', async () => {
		await seedRealm();

		const result = await ok('tune_realm', {
			realm: 'AM',
			notes: 'Prefer player feedback',
			half_life_days: 30,
			loudness: 8
		});

		expect(result).toEqual({
			realm: 'AM',
			version: 1,
			notes: 'Prefer player feedback',
			settings: { halfLifeDays: 30, loudness: 8 }
		});
	});

	it('changes only what is given and keeps the rest', async () => {
		await seedRealm();
		await ok('tune_realm', { realm: 'AM', notes: 'kept', half_life_days: 30 });

		const result = await ok('tune_realm', { realm: 'AM', loudness: 2 });

		expect(result).toEqual({
			realm: 'AM',
			version: 2,
			notes: 'kept',
			settings: { halfLifeDays: 30, loudness: 2 }
		});
	});

	it('does not bump the version when nothing changes', async () => {
		await seedRealm();
		await ok('tune_realm', { realm: 'AM', notes: 'same' });

		const result = await ok('tune_realm', { realm: 'AM', notes: 'same', loudness: 5 });

		expect(result.version).toBe(1);
	});

	it('names the Realm by its current key', async () => {
		await seedRealm();
		await ok('rename_realm_key', { realm: 'AM', key: 'ZZ' });

		const result = await ok('tune_realm', { realm: 'am', notes: 'n' });

		expect(result.realm).toBe('ZZ');
	});

	it.each([
		['half_life_days of 0', { half_life_days: 0 }],
		['a negative half_life_days', { half_life_days: -3 }],
		['half_life_days of 366', { half_life_days: 366 }],
		['a string half_life_days', { half_life_days: '7' }],
		['loudness of 0', { loudness: 0 }],
		['a negative loudness', { loudness: -1 }],
		['loudness of 1001', { loudness: 1001 }],
		['a string loudness', { loudness: '7' }],
		['notes of 4001 characters', { notes: 'x'.repeat(4001) }],
		['numeric notes', { notes: 7 }]
	])('refuses %s as invalid, changing nothing', async (_name, args) => {
		await seedRealm();

		await refused('tune_realm', { realm: 'AM', ...args }, 'invalid');

		expect(await ok('get_attributes', { realm: 'AM' })).toMatchObject({
			version: 0,
			notes: '',
			settings: { halfLifeDays: 14, loudness: 5 }
		});
	});

	it('accepts the upper bounds', async () => {
		await seedRealm();

		const result = await ok('tune_realm', {
			realm: 'AM',
			notes: 'x'.repeat(4000),
			half_life_days: 365,
			loudness: 1000
		});

		expect(result.settings).toEqual({ halfLifeDays: 365, loudness: 1000 });
		expect(result.notes).toHaveLength(4000);
	});

	it('refuses the camelCase spelling of a setting as an unknown argument', async () => {
		await seedRealm();

		const result = await refused('tune_realm', { realm: 'AM', halfLifeDays: 7 }, 'invalid');

		expect(text(result)).toContain('unknown argument "halfLifeDays"');
	});

	it('refuses an unknown Realm with not_found', async () => {
		await refused('tune_realm', { realm: 'NOPE', notes: 'n' }, 'not_found');
	});

	it('requires realm', async () => {
		await refused('tune_realm', { notes: 'n' }, 'invalid');
	});

	it('records no Event', async () => {
		await seedRealm(1);
		const before = lastSeq();

		await ok('tune_realm', { realm: 'AM', notes: 'n', loudness: 9 });
		await refused('tune_realm', { realm: 'AM', loudness: 0 }, 'invalid');

		expect(lastSeq()).toBe(before);
	});
});
