import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteLabour, moveLabour } from '#lib/server/domain/labours.ts';
import { deleteRealm } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import {
	defineAttribute,
	deleteAttribute,
	readAttributes,
	readRealmAgent,
	readValues,
	setValues,
	tuneRealm
} from './attributes.ts';

let db: Db;
let actor: Actor;
let realm: { id: number };

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realm = seedRealm(db, 'AM');
});

afterEach(() => {
	db.$client.close();
});

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-02T00:00:00Z');
const T2 = new Date('2026-01-03T00:00:00Z');
const T3 = new Date('2026-01-04T00:00:00Z');

function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

type Input = Record<string, unknown>;

const scale = (key = 'quality', min = 1, max = 5, extra: Input = {}): Input => ({
	key,
	kind: 'scale',
	label: `Label ${key}`,
	rubric: `Rubric ${key}`,
	spec: { min, max },
	...extra
});

const tags = (
	key = 'area',
	members = ['a', 'b', 'c'],
	max: number | null | undefined = undefined,
	extra: Input = {}
): Input => ({
	key,
	kind: 'tags',
	label: `Label ${key}`,
	rubric: `Rubric ${key}`,
	spec: {
		members: members.map((m) => ({ key: m, label: m.toUpperCase() })),
		...(max === undefined ? {} : { max })
	},
	...extra
});

const text = (key = 'note', max: number | undefined = undefined, extra: Input = {}): Input => ({
	key,
	kind: 'text',
	label: `Label ${key}`,
	rubric: `Rubric ${key}`,
	...(max === undefined ? {} : { spec: { max } }),
	...extra
});

function define(input: Input, now = T0, realmId = realm.id, by: Actor = actor) {
	return defineAttribute(db, by, realmId, input as never, now);
}

const attributeOf = (key: string, realmId = realm.id) =>
	readAttributes(db, realmId).find((a) => a.key === key)!;

const versionOf = (realmId = realm.id) => readRealmAgent(db, realmId).version;

const newLabour = (realmId = realm.id) => seedLabour(db, { realmId });

function set(labourId: number, values: Record<string, unknown>, now = T0, by: Actor = actor) {
	return setValues(db, by, labourId, values, now);
}

const valueOf = (labourId: number, key: string) =>
	readValues(db, labourId).find((v) => v.key === key);

const chars = (n: number) => 'x'.repeat(n);

// Runs `action` and proves it left the board alone: no Event, no `labours.updatedAt`.
function quiet<T>(action: () => T): T {
	const pinned = new Date(1_000);
	db.update(labours).set({ updatedAt: pinned }).run();
	const eventsBefore = db.select().from(events).all().length;

	const result = action();

	expect(db.select().from(events).all()).toHaveLength(eventsBefore);
	const stamps = db.select({ updatedAt: labours.updatedAt }).from(labours).all();
	expect(stamps.length).toBeGreaterThan(0);
	expect(stamps.map((s) => s.updatedAt.getTime())).toEqual(stamps.map(() => 1_000));
	return result;
}

const BOARD_TABLES = new Set([
	'users',
	'sessions',
	'invites',
	'api_tokens',
	'realms',
	'realm_keys',
	'states',
	'substates',
	'labours',
	'labour_keys',
	'comments',
	'quests',
	'quest_labours',
	'events'
]);

// Rows in every table that is not a board table: the agent layer's own storage.
function agentRows(): number {
	const names = db.$client
		.prepare(
			"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%drizzle%' and name not like 'labour_text%' and name <> 'derived_builds'"
		)
		.all() as { name: string }[];
	return names
		.filter(({ name }) => !BOARD_TABLES.has(name))
		.reduce(
			(sum, { name }) =>
				sum + (db.$client.prepare(`select count(*) as c from "${name}"`).get() as { c: number }).c,
			0
		);
}

describe('reading a Realm with no agent data', () => {
	it('reads version 0, empty notes and the default settings', () => {
		expect(readRealmAgent(db, realm.id)).toEqual({
			version: 0,
			notes: '',
			halfLifeDays: 14,
			loudness: 5
		});
	});

	it('has no Attributes', () => {
		expect(readAttributes(db, realm.id)).toEqual([]);
	});

	it('refuses an unknown Realm with not_found', () => {
		expectDomainError(() => readRealmAgent(db, 9999), 'not_found');
	});

	it('refuses to define, delete or tune in an unknown Realm with not_found', () => {
		expectDomainError(() => define(scale(), T0, 9999), 'not_found');
		expectDomainError(() => deleteAttribute(db, actor, 9999, 'quality', T0), 'not_found');
		expectDomainError(() => tuneRealm(db, actor, 9999, { loudness: 2 }, T0), 'not_found');
	});
});

describe('defining an Attribute', () => {
	it('creates a scale Attribute and returns it with the new version', () => {
		const result = define(scale('quality', 1, 5), T0);

		expect(result.version).toBe(1);
		expect(result.attribute).toMatchObject({
			key: 'quality',
			kind: 'scale',
			label: 'Label quality',
			rubric: 'Rubric quality',
			spec: { min: 1, max: 5 },
			position: 0,
			createdAt: T0,
			revisedAt: T0,
			updatedAt: T0,
			held: 0,
			stale: 0,
			counts: {}
		});
		expect(result.attribute.id).toEqual(expect.any(Number));
		expect(readAttributes(db, realm.id)).toEqual([result.attribute]);
	});

	it('normalizes a tags spec: members carry a rubric, max is null when unlimited', () => {
		const { attribute } = define(tags('area', ['a', 'b']), T0);

		expect(attribute.spec).toEqual({
			members: [
				{ key: 'a', label: 'A', rubric: '' },
				{ key: 'b', label: 'B', rubric: '' }
			],
			max: null
		});
		expect(attribute.counts).toEqual({ a: 0, b: 0 });
	});

	it('keeps a member rubric and an explicit tags max', () => {
		const { attribute } = define(
			{
				...tags('area'),
				spec: { members: [{ key: 'a', label: 'A', rubric: 'Means a' }], max: 3 }
			},
			T0
		);

		expect(attribute.spec).toEqual({
			members: [{ key: 'a', label: 'A', rubric: 'Means a' }],
			max: 3
		});
	});

	it('reads an explicit max of null as unlimited', () => {
		expect((define(tags('area', ['a'], null)).attribute.spec as { max: unknown }).max).toBeNull();
	});

	it('defaults a text spec to a max of 2000', () => {
		expect(define(text('note')).attribute.spec).toEqual({ max: 2000 });
	});

	it('keeps an explicit text max', () => {
		expect(define(text('note', 50)).attribute.spec).toEqual({ max: 50 });
	});

	it('trims label and rubric', () => {
		const { attribute } = define({ ...scale(), label: '  Quality \n', rubric: '\t How good  ' });

		expect([attribute.label, attribute.rubric]).toEqual(['Quality', 'How good']);
	});

	it('appends new Attributes in order', () => {
		define(scale('a'));
		define(scale('b'));
		define(text('c'));

		expect(readAttributes(db, realm.id).map((a) => [a.key, a.position])).toEqual([
			['a', 0],
			['b', 1],
			['c', 2]
		]);
	});

	it('keeps Attributes per Realm: the same key may exist in two Realms', () => {
		const other = seedRealm(db, 'BL');

		define(scale('quality'));
		define(scale('quality', 0, 10), T0, other.id);

		expect(attributeOf('quality', realm.id).spec).toEqual({ min: 1, max: 5 });
		expect(attributeOf('quality', other.id).spec).toEqual({ min: 0, max: 10 });
		expect(attributeOf('quality', other.id).position).toBe(0);
	});

	it('accepts a scale range below zero', () => {
		expect(define(scale('mood', -5, 5)).attribute.spec).toEqual({ min: -5, max: 5 });
	});
});

describe('Attribute keys', () => {
	it.each(['Quality', '1quality', 'my_key', '-key', '', 'a b', 'a.b', 'x'.repeat(33)])(
		'refuses the key %j as invalid',
		(key) => {
			expectDomainError(() => define(scale(key)), 'invalid');
		}
	);

	it('accepts a 32-character key and a key with digits and hyphens', () => {
		expect(define(scale('a'.repeat(32))).attribute.key).toBe('a'.repeat(32));
		expect(define(scale('a1-b2')).attribute.key).toBe('a1-b2');
	});

	it.each([
		'rank',
		'priority',
		'similarity',
		'keywords',
		'sentiment',
		'pain',
		'delight',
		'affinity',
		'skill_fit',
		'mentions',
		'pulled_in',
		'evidence',
		'unblocks',
		'quest_finish',
		'column',
		'age',
		'activity'
	])('refuses the reserved key %s as invalid, for every kind', (key) => {
		expectDomainError(() => define(scale(key)), 'invalid');
		expectDomainError(() => define(tags(key)), 'invalid');
		expectDomainError(() => define(text(key)), 'invalid');
		expect(readAttributes(db, realm.id)).toEqual([]);
		expect(versionOf()).toBe(0);
	});

	it('refuses an unknown kind as invalid', () => {
		expectDomainError(() => define({ ...scale(), kind: 'number' }), 'invalid');
		expectDomainError(() => define({ ...scale(), kind: 'Scale' }), 'invalid');
	});

	it('refuses to change the kind of an Attribute, changing nothing', () => {
		define(scale('quality'), T0);

		expectDomainError(() => define(text('quality'), T1), 'invalid');

		expect(attributeOf('quality')).toMatchObject({ kind: 'scale', spec: { min: 1, max: 5 } });
		expect(versionOf()).toBe(1);
	});

	it('refuses an invalid member key', () => {
		for (const bad of ['Bad', '1x', 'a_b', '', 'x'.repeat(33)]) {
			expectDomainError(() => define(tags('area', ['ok', bad])), 'invalid');
		}
		expect(readAttributes(db, realm.id)).toEqual([]);
	});

	it('accepts a 32-character member key', () => {
		expect(define(tags('area', ['m'.repeat(32)])).attribute.counts).toEqual({
			['m'.repeat(32)]: 0
		});
	});
});

describe('Attribute label and rubric', () => {
	it.each([
		['an empty label', { label: '' }],
		['a blank label', { label: '   ' }],
		['a 65-character label', { label: chars(65) }],
		['an empty rubric', { rubric: '' }],
		['a blank rubric', { rubric: ' \n ' }],
		['a 4001-character rubric', { rubric: chars(4001) }]
	])('refuses %s as invalid', (_name, patch) => {
		expectDomainError(() => define({ ...scale(), ...patch }), 'invalid');
		expect(readAttributes(db, realm.id)).toEqual([]);
	});

	it('accepts a 64-character label and a 4000-character rubric', () => {
		const { attribute } = define({ ...scale(), label: chars(64), rubric: chars(4000) });

		expect([attribute.label.length, attribute.rubric.length]).toEqual([64, 4000]);
	});

	it('measures the limit after trimming', () => {
		expect(define({ ...scale(), label: ` ${chars(64)} ` }).attribute.label).toBe(chars(64));
	});

	it('requires label, rubric and (except for text) spec when creating', () => {
		const { label: _l, ...noLabel } = scale();
		const { rubric: _r, ...noRubric } = scale();
		const { spec: _s, ...noScaleSpec } = scale();
		const { spec: _t, ...noTagsSpec } = tags();

		expectDomainError(() => define(noLabel), 'invalid');
		expectDomainError(() => define(noRubric), 'invalid');
		expectDomainError(() => define(noScaleSpec), 'invalid');
		expectDomainError(() => define(noTagsSpec), 'invalid');
		expect(readAttributes(db, realm.id)).toEqual([]);
	});
});

describe('scale specs', () => {
	it.each([
		['min equal to max', { min: 5, max: 5 }],
		['min above max', { min: 6, max: 5 }],
		['a range wider than 100', { min: 0, max: 101 }],
		['a fractional min', { min: 1.5, max: 5 }],
		['a fractional max', { min: 1, max: 5.5 }],
		['a string max', { min: 1, max: '5' }],
		['a null max', { min: 1, max: null }],
		['a missing max', { min: 1 }],
		['a missing min', { max: 5 }],
		['an empty spec', {}]
	])('refuses %s as invalid', (_name, spec) => {
		expectDomainError(() => define(scale('quality', 1, 5, { spec })), 'invalid');
		expect(readAttributes(db, realm.id)).toEqual([]);
	});

	it('accepts a range of exactly 100 and a range of 1', () => {
		expect(define(scale('wide', 0, 100)).attribute.spec).toEqual({ min: 0, max: 100 });
		expect(define(scale('narrow', 3, 4)).attribute.spec).toEqual({ min: 3, max: 4 });
	});

	it('refuses members on a scale', () => {
		expectDomainError(
			() => define(scale('quality', 1, 5, { spec: { min: 1, max: 5, members: [] } })),
			'invalid'
		);
		expectDomainError(
			() =>
				define(
					scale('quality', 1, 5, { spec: { min: 1, max: 5, members: [{ key: 'a', label: 'A' }] } })
				),
			'invalid'
		);
	});
});

describe('tags specs', () => {
	const members = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
	const one = { key: 'a', label: 'A' };

	it.each([
		['no members', { members: [] }],
		['a missing members list', {}],
		['members that are not a list', { members: 'a' }],
		['duplicate member keys', { members: [one, { key: 'a', label: 'Again' }] }],
		['an empty member label', { members: [{ key: 'a', label: '' }] }],
		['a 65-character member label', { members: [{ key: 'a', label: chars(65) }] }],
		['a 1001-character member rubric', { members: [{ ...one, rubric: chars(1001) }] }],
		['a max of 0', { members: [one], max: 0 }],
		['a negative max', { members: [one], max: -1 }],
		['a max of 65', { members: [one], max: 65 }],
		['a fractional max', { members: [one], max: 1.5 }],
		['a string max', { members: [one], max: '2' }],
		['a min', { members: [one], min: 1 }]
	])('refuses %s as invalid', (_name, spec) => {
		expectDomainError(() => define({ ...tags(), spec }), 'invalid');
		expect(readAttributes(db, realm.id)).toEqual([]);
	});

	it('refuses 65 members and accepts 64', () => {
		expectDomainError(() => define(tags('area', members(65))), 'invalid');
		expect(define(tags('area', members(64))).attribute.counts).toHaveProperty('m63', 0);
	});

	it('accepts a 64-character member label and a 1000-character member rubric', () => {
		const spec = { members: [{ key: 'a', label: chars(64), rubric: chars(1000) }] };

		expect(define({ ...tags(), spec }).attribute.spec).toEqual({
			members: [{ key: 'a', label: chars(64), rubric: chars(1000) }],
			max: null
		});
	});

	it('accepts a max of 1 and a max of 64', () => {
		expect((define(tags('one', ['a', 'b'], 1)).attribute.spec as { max: number }).max).toBe(1);
		expect((define(tags('many', members(64), 64)).attribute.spec as { max: number }).max).toBe(64);
	});
});

describe('text specs', () => {
	it.each([
		['a max of 0', { max: 0 }],
		['a negative max', { max: -1 }],
		['a max of 20001', { max: 20001 }],
		['a fractional max', { max: 1.5 }],
		['a string max', { max: '10' }],
		['a null max', { max: null }],
		['members', { max: 10, members: [{ key: 'a', label: 'A' }] }],
		['a min', { max: 10, min: 1 }]
	])('refuses %s as invalid', (_name, spec) => {
		expectDomainError(() => define({ ...text(), spec }), 'invalid');
		expect(readAttributes(db, realm.id)).toEqual([]);
	});

	it('accepts a max of 1 and a max of 20000', () => {
		expect(define(text('short', 1)).attribute.spec).toEqual({ max: 1 });
		expect(define(text('long', 20000)).attribute.spec).toEqual({ max: 20000 });
	});
});

describe('the 32 Attribute cap', () => {
	const fill = (n: number, realmId = realm.id) => {
		for (let i = 0; i < n; i++) define(scale(`attr-${i}`), T0, realmId);
	};

	it('refuses the 33rd Attribute with conflict, changing nothing', () => {
		fill(32);
		const version = versionOf();

		expectDomainError(() => define(scale('one-more')), 'conflict');

		expect(readAttributes(db, realm.id)).toHaveLength(32);
		expect(versionOf()).toBe(version);
	});

	it('still lets an Attribute of a full Realm be revised', () => {
		fill(32);

		define(scale('attr-0', 1, 5, { label: 'Changed' }), T1);

		expect(attributeOf('attr-0').label).toBe('Changed');
	});

	it('counts per Realm, and frees a slot on delete', () => {
		fill(32);
		const other = seedRealm(db, 'BL');

		define(scale('fresh'), T0, other.id);
		deleteAttribute(db, actor, realm.id, 'attr-5', T1);
		define(scale('fits-now'), T1);

		expect(attributeOf('fits-now').position).toBe(31);
	});
});

describe('Attribute index', () => {
	beforeEach(() => {
		define(scale('a'));
		define(scale('b'));
	});

	const order = () => readAttributes(db, realm.id).map((a) => a.key);
	const positions = () => readAttributes(db, realm.id).map((a) => a.position);

	it('places a new Attribute at the index, shifting the rest down', () => {
		define(scale('x', 1, 5, { index: 0 }));
		expect(order()).toEqual(['x', 'a', 'b']);

		define(scale('y', 1, 5, { index: 2 }));
		expect(order()).toEqual(['x', 'a', 'y', 'b']);
		expect(positions()).toEqual([0, 1, 2, 3]);
	});

	it('accepts an index equal to the current count when creating: it appends', () => {
		define(scale('x', 1, 5, { index: 2 }));

		expect(order()).toEqual(['a', 'b', 'x']);
	});

	it.each([3, 10, -1, 1.5])('refuses the index %s when creating', (index) => {
		expectDomainError(() => define(scale('x', 1, 5, { index })), 'invalid');

		expect(order()).toEqual(['a', 'b']);
	});

	it('moves a revised Attribute to the index', () => {
		define(scale('c'));

		define({ key: 'c', kind: 'scale', index: 0 }, T1);
		expect(order()).toEqual(['c', 'a', 'b']);

		define({ key: 'c', kind: 'scale', index: 2 }, T2);
		expect(order()).toEqual(['a', 'b', 'c']);
		expect(positions()).toEqual([0, 1, 2]);
	});

	it('refuses a revise index outside 0..n-1, where n does not grow', () => {
		expectDomainError(() => define({ key: 'a', kind: 'scale', index: 2 }, T1), 'invalid');
		expectDomainError(() => define({ key: 'a', kind: 'scale', index: -1 }, T1), 'invalid');
		expect(order()).toEqual(['a', 'b']);
	});

	it('leaves the position alone when a revise omits the index', () => {
		define({ key: 'a', kind: 'scale', label: 'Renamed' }, T1);

		expect(order()).toEqual(['a', 'b']);
	});

	it('treats a revise to the current index as no change', () => {
		const version = versionOf();

		const result = define({ key: 'b', kind: 'scale', index: 1 }, T1);

		expect(result.version).toBe(version);
		expect(attributeOf('b').updatedAt).toEqual(T0);
	});

	it('moves an Attribute without touching its revisedAt, and bumps its updatedAt', () => {
		define({ key: 'b', kind: 'scale', index: 0 }, T1);

		expect(attributeOf('b')).toMatchObject({ position: 0, revisedAt: T0, updatedAt: T1 });
	});

	it('orders values by Attribute position', () => {
		const labour = newLabour();
		set(labour.id, { a: 1, b: 2 });

		define({ key: 'b', kind: 'scale', index: 0 }, T1);

		expect(readValues(db, labour.id).map((v) => v.key)).toEqual(['b', 'a']);
	});
});

describe('deleting an Attribute', () => {
	it('deletes it, returns the new version, and re-packs positions', () => {
		define(scale('a'));
		define(scale('b'));
		define(scale('c'));
		const version = versionOf();

		const result = deleteAttribute(db, actor, realm.id, 'b', T1);

		expect(result).toEqual({ version: version + 1 });
		expect(readAttributes(db, realm.id).map((a) => [a.key, a.position])).toEqual([
			['a', 0],
			['c', 1]
		]);
	});

	it('re-packs when the first Attribute goes', () => {
		define(scale('a'));
		define(scale('b'));

		deleteAttribute(db, actor, realm.id, 'a', T1);

		expect(attributeOf('b').position).toBe(0);
	});

	it('allows a new Attribute at the end of the re-packed list', () => {
		define(scale('a'));
		define(scale('b'));
		deleteAttribute(db, actor, realm.id, 'a', T1);

		define(scale('c', 1, 5, { index: 1 }), T2);

		expect(readAttributes(db, realm.id).map((a) => a.key)).toEqual(['b', 'c']);
	});

	it('deletes every value of the Attribute and keeps the others', () => {
		define(scale('a'));
		define(scale('b'));
		const one = newLabour();
		const two = newLabour();
		set(one.id, { a: 1, b: 2 });
		set(two.id, { a: 3 });

		deleteAttribute(db, actor, realm.id, 'a', T1);

		expect(readValues(db, one.id).map((v) => [v.key, v.value])).toEqual([['b', 2]]);
		expect(readValues(db, two.id)).toEqual([]);
	});

	it('leaves the same-keyed Attribute of another Realm alone', () => {
		const other = seedRealm(db, 'BL');
		define(scale('a'));
		define(scale('a'), T0, other.id);
		const mine = newLabour(realm.id);
		const theirs = newLabour(other.id);
		set(mine.id, { a: 1 });
		set(theirs.id, { a: 2 });
		const theirVersion = versionOf(other.id);

		deleteAttribute(db, actor, realm.id, 'a', T1);

		expect(readValues(db, theirs.id).map((v) => v.value)).toEqual([2]);
		expect(readAttributes(db, other.id)).toHaveLength(1);
		expect(versionOf(other.id)).toBe(theirVersion);
	});

	it('refuses an unknown key with not_found, changing nothing', () => {
		define(scale('a'));

		expectDomainError(() => deleteAttribute(db, actor, realm.id, 'nope', T1), 'not_found');

		expect(versionOf()).toBe(1);
		expect(readAttributes(db, realm.id)).toHaveLength(1);
	});

	it('lets a deleted key be defined afresh, as a new Attribute with no values', () => {
		define(scale('a'));
		const labour = newLabour();
		set(labour.id, { a: 4 });
		deleteAttribute(db, actor, realm.id, 'a', T1);

		define(text('a'), T2);

		expect(attributeOf('a')).toMatchObject({ kind: 'text', held: 0, createdAt: T2 });
		expect(readValues(db, labour.id)).toEqual([]);
	});
});

describe('revising an Attribute', () => {
	beforeEach(() => {
		define(scale('quality', 1, 5), T0);
	});

	it('moves only updatedAt when the label changes', () => {
		const result = define({ key: 'quality', kind: 'scale', label: 'Renamed' }, T1);

		expect(result.version).toBe(2);
		expect(result.attribute).toMatchObject({
			label: 'Renamed',
			createdAt: T0,
			revisedAt: T0,
			updatedAt: T1
		});
	});

	it('moves revisedAt and updatedAt when the rubric changes', () => {
		define({ key: 'quality', kind: 'scale', rubric: 'A sharper rubric' }, T1);

		expect(attributeOf('quality')).toMatchObject({
			rubric: 'A sharper rubric',
			createdAt: T0,
			revisedAt: T1,
			updatedAt: T1
		});
	});

	it('moves revisedAt and updatedAt when the spec changes', () => {
		define({ key: 'quality', kind: 'scale', spec: { min: 1, max: 7 } }, T1);

		expect(attributeOf('quality')).toMatchObject({
			spec: { min: 1, max: 7 },
			revisedAt: T1,
			updatedAt: T1
		});
	});

	it('changes everything it is given in a single version step', () => {
		const result = define(
			{ key: 'quality', kind: 'scale', label: 'L', rubric: 'R', spec: { min: 0, max: 9 } },
			T1
		);

		expect(result.version).toBe(2);
	});

	it('changes nothing, and does not bump, when nothing differs', () => {
		const before = attributeOf('quality');

		const result = define(scale('quality', 1, 5), T1);

		expect(result.version).toBe(1);
		expect(result.attribute).toEqual(before);
		expect(attributeOf('quality')).toEqual(before);
		expect(versionOf()).toBe(1);
	});

	it('treats a bare key and kind as a revise that changes nothing', () => {
		const before = attributeOf('quality');

		const result = define({ key: 'quality', kind: 'scale' }, T1);

		expect(result.version).toBe(1);
		expect(attributeOf('quality')).toEqual(before);
	});

	it('compares a trimmed label and rubric: padding alone is no change', () => {
		const result = define(
			{ key: 'quality', kind: 'scale', label: '  Label quality ', rubric: ' Rubric quality\n' },
			T1
		);

		expect(result.version).toBe(1);
		expect(attributeOf('quality').updatedAt).toEqual(T0);
	});

	it('compares the normalized spec: restating a text default is no change', () => {
		define(text('note'), T0);
		const version = versionOf();

		const result = define(text('note', 2000), T1);

		expect(result.version).toBe(version);
		expect(attributeOf('note')).toMatchObject({ revisedAt: T0, updatedAt: T0 });
	});

	it('compares the normalized spec: tags max null and absent are the same', () => {
		define(tags('area', ['a', 'b']), T0);
		const version = versionOf();

		const result = define(tags('area', ['a', 'b'], null), T1);

		expect(result.version).toBe(version);
		expect(attributeOf('area').revisedAt).toEqual(T0);
	});

	it('treats a changed member label, order or rubric as a spec change', () => {
		define(tags('area', ['a', 'b']), T0);
		const withMembers = (...ms: { key: string; label: string; rubric?: string }[]) => ({
			key: 'area',
			kind: 'tags',
			spec: { members: ms }
		});

		define(withMembers({ key: 'a', label: 'Renamed' }, { key: 'b', label: 'B' }), T1);
		expect(attributeOf('area').revisedAt).toEqual(T1);

		define(withMembers({ key: 'b', label: 'B' }, { key: 'a', label: 'Renamed' }), T2);
		expect(attributeOf('area').revisedAt).toEqual(T2);

		define(
			withMembers(
				{ key: 'b', label: 'B', rubric: 'Now with a rubric' },
				{ key: 'a', label: 'Renamed' }
			),
			T3
		);
		expect(attributeOf('area').revisedAt).toEqual(T3);
	});

	it('treats a changed tags max as a spec change', () => {
		define(tags('area', ['a', 'b']), T0);

		define(tags('area', ['a', 'b'], 1), T1);

		expect(attributeOf('area')).toMatchObject({ revisedAt: T1, spec: { max: 1 } });
	});

	it('refuses an invalid revise, changing nothing', () => {
		const before = attributeOf('quality');

		expectDomainError(
			() => define({ key: 'quality', kind: 'scale', label: 'New', rubric: '' }, T1),
			'invalid'
		);
		expectDomainError(
			() => define({ key: 'quality', kind: 'scale', label: 'New', spec: { min: 5, max: 1 } }, T1),
			'invalid'
		);

		expect(attributeOf('quality')).toEqual(before);
		expect(versionOf()).toBe(1);
	});

	it('refuses a spec field that does not belong to the kind on a revise', () => {
		expectDomainError(
			() =>
				define(
					{
						key: 'quality',
						kind: 'scale',
						spec: { min: 1, max: 5, members: [{ key: 'a', label: 'A' }] }
					},
					T1
				),
			'invalid'
		);
	});
});

describe('narrowing a scale', () => {
	it('clamps every value into the new range, leaving setBy and setAt alone', () => {
		const ada = { id: seedUser(db, 'ada') };
		define(scale('quality', 1, 10), T0);
		const [low, mid, high] = [newLabour(), newLabour(), newLabour()];
		set(low.id, { quality: 1 }, T1, ada);
		set(mid.id, { quality: 5 }, T1, ada);
		set(high.id, { quality: 10 }, T1, ada);

		define(scale('quality', 3, 7), T2, realm.id, actor);

		expect(valueOf(low.id, 'quality')).toMatchObject({
			value: 3,
			setBy: ada.id,
			via: null,
			setAt: T1
		});
		expect(valueOf(mid.id, 'quality')).toMatchObject({
			value: 5,
			setBy: ada.id,
			via: null,
			setAt: T1
		});
		expect(valueOf(high.id, 'quality')).toMatchObject({
			value: 7,
			setBy: ada.id,
			via: null,
			setAt: T1
		});
	});

	it('clamps a value that sits wholly outside the new range to its nearest edge', () => {
		define(scale('quality', 1, 10), T0);
		const [below, above] = [newLabour(), newLabour()];
		set(below.id, { quality: 2 });
		set(above.id, { quality: 9 });

		define(scale('quality', 6, 8), T1);

		expect(valueOf(below.id, 'quality')!.value).toBe(6);
		expect(valueOf(above.id, 'quality')!.value).toBe(8);
	});

	it('marks the clamped values stale, since the spec was revised', () => {
		define(scale('quality', 1, 10), T0);
		const labour = newLabour();
		set(labour.id, { quality: 9 }, T1);

		define(scale('quality', 1, 5), T2);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(true);
	});

	it('keeps counts in step with the clamped values', () => {
		define(scale('quality', 1, 10), T0);
		for (const n of [8, 9, 10, 2]) set(newLabour().id, { quality: n });

		define(scale('quality', 1, 5), T1);

		expect(attributeOf('quality')).toMatchObject({ held: 4, counts: { '5': 3, '2': 1 } });
	});

	it('leaves values that already fit untouched when the range widens', () => {
		define(scale('quality', 1, 5), T0);
		const labour = newLabour();
		set(labour.id, { quality: 4 }, T1);

		define(scale('quality', 0, 10), T2);

		expect(valueOf(labour.id, 'quality')).toMatchObject({ value: 4, setAt: T1, setBy: actor.id });
	});
});

describe('removing tags members', () => {
	it('takes the members out of every value, leaving setBy and setAt alone', () => {
		const ada = { id: seedUser(db, 'ada') };
		define(tags('area', ['a', 'b', 'c']), T0);
		const one = newLabour();
		const two = newLabour();
		set(one.id, { area: ['a', 'b'] }, T1, ada);
		set(two.id, { area: ['b', 'c'] }, T1, ada);

		define(tags('area', ['b', 'c']), T2, realm.id, actor);

		expect(valueOf(one.id, 'area')).toMatchObject({
			value: ['b'],
			setBy: ada.id,
			via: null,
			setAt: T1
		});
		expect(valueOf(two.id, 'area')).toMatchObject({
			value: ['b', 'c'],
			setBy: ada.id,
			via: null,
			setAt: T1
		});
	});

	it('deletes a value left with no members', () => {
		define(tags('area', ['a', 'b', 'c']), T0);
		const emptied = newLabour();
		const kept = newLabour();
		set(emptied.id, { area: ['a'] });
		set(kept.id, { area: ['a', 'c'] });

		define(tags('area', ['b', 'c']), T1);

		expect(valueOf(emptied.id, 'area')).toBeUndefined();
		expect(valueOf(kept.id, 'area')!.value).toEqual(['c']);
		expect(attributeOf('area')).toMatchObject({ held: 1, counts: { b: 0, c: 1 } });
	});

	it('leaves values alone when only a member label changes', () => {
		define(tags('area', ['a', 'b']), T0);
		const labour = newLabour();
		set(labour.id, { area: ['a', 'b'] }, T1);

		define(
			{
				key: 'area',
				kind: 'tags',
				spec: {
					members: [
						{ key: 'a', label: 'Renamed' },
						{ key: 'b', label: 'B' }
					]
				}
			},
			T2
		);

		expect(valueOf(labour.id, 'area')).toMatchObject({ value: ['a', 'b'], setAt: T1 });
	});
});

describe('lowering a max below a held value', () => {
	it('refuses a tags max below a held selection with conflict, changing nothing', () => {
		define(tags('area', ['a', 'b', 'c']), T0);
		const labour = newLabour();
		set(labour.id, { area: ['a', 'b', 'c'] }, T1);
		const before = attributeOf('area');
		const version = versionOf();

		expectDomainError(
			() =>
				define(
					{
						...tags('area', ['a', 'b', 'c'], 2),
						label: 'Would-be rename',
						rubric: 'Would-be rubric'
					},
					T2
				),
			'conflict'
		);

		expect(attributeOf('area')).toEqual(before);
		expect(valueOf(labour.id, 'area')).toMatchObject({ value: ['a', 'b', 'c'], setAt: T1 });
		expect(versionOf()).toBe(version);
	});

	it('refuses a text max below a held text with conflict, changing nothing', () => {
		define(text('note', 100), T0);
		const labour = newLabour();
		set(labour.id, { note: 'twelve chars' }, T1);
		const before = attributeOf('note');

		expectDomainError(() => define(text('note', 11), T2), 'conflict');

		expect(attributeOf('note')).toEqual(before);
		expect(valueOf(labour.id, 'note')!.value).toBe('twelve chars');
	});

	it('accepts a max equal to the longest held value', () => {
		define(text('note', 100), T0);
		set(newLabour().id, { note: 'twelve chars' });
		define(tags('area', ['a', 'b', 'c']), T0);
		set(newLabour().id, { area: ['a', 'b'] });

		expect((define(text('note', 12), T1).attribute.spec as { max: number }).max).toBe(12);
		expect(
			(define(tags('area', ['a', 'b', 'c'], 2), T1).attribute.spec as { max: number }).max
		).toBe(2);
	});

	it('is decided across all Labours: one over-long value is enough', () => {
		define(text('note', 100), T0);
		set(newLabour().id, { note: 'ab' });
		set(newLabour().id, { note: 'abcdefghij' });

		expectDomainError(() => define(text('note', 5), T1), 'conflict');
	});

	it('does not look at Labours of other Realms', () => {
		const other = seedRealm(db, 'BL');
		define(text('note', 100), T0);
		define(text('note', 100), T0, other.id);
		set(newLabour(other.id).id, { note: 'abcdefghij' });

		expect((define(text('note', 5), T1).attribute.spec as { max: number }).max).toBe(5);
	});

	it('allows raising a max', () => {
		define(text('note', 10), T0);
		set(newLabour().id, { note: 'abcdefghij' });

		expect((define(text('note', 500), T1).attribute.spec as { max: number }).max).toBe(500);
	});
});

describe('setting scale values', () => {
	let labour: { id: number };

	beforeEach(() => {
		define(scale('quality', 1, 5));
		labour = newLabour();
	});

	it('stores an integer within the range, including both ends', () => {
		for (const n of [1, 3, 5]) {
			set(labour.id, { quality: n });
			expect(valueOf(labour.id, 'quality')!.value).toBe(n);
		}
	});

	it('returns the stored values as ValueViews', () => {
		const ada = { id: seedUser(db, 'ada') };

		const result = set(labour.id, { quality: 4 }, T1, ada);

		expect(result).toEqual([
			{ key: 'quality', kind: 'scale', value: 4, setBy: ada.id, via: null, setAt: T1, stale: false }
		]);
		expect(readValues(db, labour.id)).toEqual(result);
	});

	it.each([
		['below the range', 0],
		['above the range', 6],
		['a fraction', 2.5],
		['a numeric string', '3'],
		['a boolean', true],
		['an array', [3]],
		['an empty array', []],
		['an empty string', ''],
		['NaN', Number.NaN],
		['an object', { value: 3 }]
	])('refuses %s as invalid, storing nothing', (_name, value) => {
		const version = versionOf();

		expectDomainError(() => set(labour.id, { quality: value }), 'invalid');

		expect(readValues(db, labour.id)).toEqual([]);
		expect(versionOf()).toBe(version);
	});

	it('keeps the old value when a replacement is refused', () => {
		set(labour.id, { quality: 2 }, T0);

		expectDomainError(() => set(labour.id, { quality: 9 }, T1), 'invalid');

		expect(valueOf(labour.id, 'quality')).toMatchObject({ value: 2, setAt: T0 });
	});

	it('counts negative scales by their value', () => {
		define(scale('mood', -2, 2));
		set(newLabour().id, { mood: -2 });
		set(newLabour().id, { mood: -2 });
		set(newLabour().id, { mood: 0 });

		expect(attributeOf('mood').counts).toEqual({ '-2': 2, '0': 1 });
	});
});

describe('setting tags values', () => {
	let labour: { id: number };

	beforeEach(() => {
		define(tags('area', ['a', 'b', 'c', 'd']));
		labour = newLabour();
	});

	it('stores the member keys sorted with repeats removed', () => {
		set(labour.id, { area: ['d', 'a', 'a', 'c', 'd'] });

		expect(valueOf(labour.id, 'area')!.value).toEqual(['a', 'c', 'd']);
	});

	it.each([
		['an unknown member', ['a', 'zzz']],
		['a member key in the wrong case', ['A']],
		['a plain string', 'a'],
		['a number', 1],
		['a non-string element', ['a', 1]],
		['a nested array', [['a']]],
		['an object', { a: true }]
	])('refuses %s as invalid, storing nothing', (_name, value) => {
		expectDomainError(() => set(labour.id, { area: value }), 'invalid');

		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('enforces the max: at most max keys are accepted', () => {
		define(tags('pick', ['a', 'b', 'c'], 2));

		set(labour.id, { pick: ['a', 'b'] });
		expect(valueOf(labour.id, 'pick')!.value).toEqual(['a', 'b']);

		expectDomainError(() => set(labour.id, { pick: ['a', 'b', 'c'] }), 'invalid');
		expect(valueOf(labour.id, 'pick')!.value).toEqual(['a', 'b']);
	});

	it('counts every member, zero when unheld', () => {
		set(labour.id, { area: ['a', 'b'] });
		set(newLabour().id, { area: ['b'] });

		expect(attributeOf('area')).toMatchObject({
			held: 2,
			counts: { a: 1, b: 2, c: 0, d: 0 }
		});
	});
});

describe('setting text values', () => {
	let labour: { id: number };

	beforeEach(() => {
		define(text('note', 10));
		labour = newLabour();
	});

	it('trims the text', () => {
		set(labour.id, { note: '  hello \n' });

		expect(valueOf(labour.id, 'note')!.value).toBe('hello');
	});

	it('accepts exactly max characters and refuses one more', () => {
		set(labour.id, { note: chars(10) });
		expect(valueOf(labour.id, 'note')!.value).toBe(chars(10));

		expectDomainError(() => set(labour.id, { note: chars(11) }), 'invalid');
		expect(valueOf(labour.id, 'note')!.value).toBe(chars(10));
	});

	it.each([
		['a number', 4],
		['a boolean', false],
		['an array', ['a']],
		['an object', {}]
	])('refuses %s as invalid', (_name, value) => {
		expectDomainError(() => set(labour.id, { note: value }), 'invalid');

		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('has text counts of {} however many are held', () => {
		set(labour.id, { note: 'hi' });
		set(newLabour().id, { note: 'there' });

		expect(attributeOf('note')).toMatchObject({ held: 2, counts: {} });
	});
});

describe('clearing values', () => {
	let labour: { id: number };

	beforeEach(() => {
		define(scale('quality', 1, 5));
		define(tags('area', ['a', 'b']));
		define(text('note', 10));
		labour = newLabour();
		set(labour.id, { quality: 3, area: ['a'], note: 'hi' });
	});

	it('clears a value with null, whatever the kind', () => {
		const result = set(labour.id, { quality: null, area: null, note: null }, T1);

		expect(result).toEqual([]);
		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('clears tags with an empty array', () => {
		set(labour.id, { area: [] }, T1);

		expect(valueOf(labour.id, 'area')).toBeUndefined();
		expect(attributeOf('area')).toMatchObject({ held: 0, counts: { a: 0, b: 0 } });
	});

	it('clears text with an empty or blank string', () => {
		set(labour.id, { note: '' }, T1);
		expect(valueOf(labour.id, 'note')).toBeUndefined();

		set(labour.id, { note: 'again' }, T2);
		set(labour.id, { note: '  \n ' }, T3);
		expect(valueOf(labour.id, 'note')).toBeUndefined();
	});

	it('leaves the other values alone and returns them', () => {
		const result = set(labour.id, { quality: null }, T1);

		expect(result.map((v) => v.key)).toEqual(['area', 'note']);
		expect(valueOf(labour.id, 'area')).toMatchObject({ value: ['a'], setAt: T0 });
	});

	it('updates held and counts', () => {
		set(labour.id, { quality: null }, T1);

		expect(attributeOf('quality')).toMatchObject({ held: 0, counts: {} });
	});

	it('does not accept an empty array or an empty string for a scale', () => {
		expectDomainError(() => set(labour.id, { quality: [] }), 'invalid');
		expectDomainError(() => set(labour.id, { quality: '' }), 'invalid');
		expect(valueOf(labour.id, 'quality')!.value).toBe(3);
	});

	it('does not bump the version when there was nothing to clear', () => {
		set(labour.id, { quality: null }, T1);
		const version = versionOf();

		set(labour.id, { quality: null }, T2);
		set(labour.id, {}, T3);

		expect(versionOf()).toBe(version);
	});
});

describe('setting values: references and atomicity', () => {
	beforeEach(() => {
		define(scale('quality', 1, 5));
		define(text('note', 10));
	});

	it('refuses an unknown Attribute key as invalid', () => {
		const labour = newLabour();

		expectDomainError(() => set(labour.id, { nope: 1 }), 'invalid');
		expectDomainError(() => set(labour.id, { nope: null }), 'invalid');
	});

	it('does not read a key of another Realm as known', () => {
		const other = seedRealm(db, 'BL');
		define(scale('elsewhere'), T0, other.id);
		const labour = newLabour();

		expectDomainError(() => set(labour.id, { elsewhere: 1 }), 'invalid');
	});

	it('refuses an unknown Labour with not_found', () => {
		expectDomainError(() => set(9999, { quality: 1 }), 'not_found');
	});

	it('is all or nothing: one bad entry refuses the whole call', () => {
		const labour = newLabour();
		set(labour.id, { note: 'kept' }, T0);
		const version = versionOf();

		expectDomainError(() => set(labour.id, { quality: 3, note: chars(11) }, T1), 'invalid');
		expectDomainError(() => set(labour.id, { quality: 3, note: 'ok', nope: 1 }, T1), 'invalid');
		expectDomainError(() => set(labour.id, { quality: null, note: 12 }, T1), 'invalid');

		expect(readValues(db, labour.id).map((v) => [v.key, v.value, v.setAt])).toEqual([
			['note', 'kept', T0]
		]);
		expect(versionOf()).toBe(version);
	});

	it('returns all the Labour values in position order, not only the ones set', () => {
		const labour = newLabour();
		set(labour.id, { note: 'n' });

		const result = set(labour.id, { quality: 2 });

		expect(result.map((v) => v.key)).toEqual(['quality', 'note']);
	});

	it('reads no values for a Labour with none', () => {
		expect(readValues(db, newLabour().id)).toEqual([]);
	});
});

describe('who set a value and when', () => {
	let ada: Actor;
	let labour: { id: number };

	beforeEach(() => {
		ada = { id: seedUser(db, 'ada') };
		define(scale('quality', 1, 5));
		define(scale('other', 1, 5));
		labour = newLabour();
	});

	it('records the writer and the time', () => {
		set(labour.id, { quality: 2 }, T1, ada);

		expect(valueOf(labour.id, 'quality')).toMatchObject({ setBy: ada.id, via: null, setAt: T1 });
	});

	it('rewrites setBy and setAt when the value changes', () => {
		set(labour.id, { quality: 2 }, T1, ada);

		set(labour.id, { quality: 4 }, T2, actor);

		expect(valueOf(labour.id, 'quality')).toMatchObject({
			value: 4,
			setBy: actor.id,
			via: null,
			setAt: T2
		});
	});

	it('rewrites setBy and setAt even when the value is identical', () => {
		set(labour.id, { quality: 2 }, T1, ada);

		set(labour.id, { quality: 2 }, T2, actor);

		expect(valueOf(labour.id, 'quality')).toMatchObject({
			value: 2,
			setBy: actor.id,
			via: null,
			setAt: T2
		});
	});

	it('rewrites them for identical tags and text too', () => {
		define(tags('area', ['a', 'b']));
		define(text('note', 10));
		set(labour.id, { area: ['b', 'a'], note: 'hi' }, T1, ada);

		set(labour.id, { area: ['a', 'b'], note: ' hi ' }, T2, actor);

		expect(valueOf(labour.id, 'area')).toMatchObject({ setBy: actor.id, via: null, setAt: T2 });
		expect(valueOf(labour.id, 'note')).toMatchObject({ setBy: actor.id, via: null, setAt: T2 });
	});

	it('leaves the values a call does not name untouched', () => {
		set(labour.id, { quality: 2, other: 3 }, T1, ada);

		set(labour.id, { quality: 4 }, T2, actor);

		expect(valueOf(labour.id, 'other')).toMatchObject({
			value: 3,
			setBy: ada.id,
			via: null,
			setAt: T1
		});
	});

	it('keeps the values of different Labours apart', () => {
		const second = newLabour();
		set(labour.id, { quality: 2 }, T1, ada);
		set(second.id, { quality: 5 }, T2, actor);

		expect(valueOf(labour.id, 'quality')).toMatchObject({ value: 2, setBy: ada.id });
		expect(valueOf(second.id, 'quality')).toMatchObject({ value: 5, setBy: actor.id });
	});
});

describe('staleness', () => {
	let labour: { id: number };

	beforeEach(() => {
		define(scale('quality', 1, 5), T0);
		labour = newLabour();
	});

	it('is not stale when set at or after revisedAt', () => {
		set(labour.id, { quality: 3 }, T0);
		expect(valueOf(labour.id, 'quality')!.stale).toBe(false);
		expect(attributeOf('quality')).toMatchObject({ held: 1, stale: 0 });

		set(labour.id, { quality: 3 }, T1);
		expect(valueOf(labour.id, 'quality')!.stale).toBe(false);
	});

	it('goes stale when the rubric is revised after the value was set', () => {
		set(labour.id, { quality: 3 }, T1);

		define({ key: 'quality', kind: 'scale', rubric: 'Tighter rubric' }, T2);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(true);
		expect(attributeOf('quality')).toMatchObject({ held: 1, stale: 1 });
	});

	it('goes stale when the spec is revised after the value was set', () => {
		set(labour.id, { quality: 3 }, T1);

		define(scale('quality', 1, 9), T2);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(true);
	});

	it('does not go stale from a label-only change', () => {
		set(labour.id, { quality: 3 }, T1);

		define({ key: 'quality', kind: 'scale', label: 'Renamed' }, T2);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(false);
		expect(attributeOf('quality').stale).toBe(0);
	});

	it('does not go stale from moving the Attribute', () => {
		define(scale('second'), T0);
		set(labour.id, { quality: 3 }, T1);

		define({ key: 'quality', kind: 'scale', index: 1 }, T2);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(false);
	});

	it('is cleared by setting the value again, even to the same value', () => {
		set(labour.id, { quality: 3 }, T1);
		define({ key: 'quality', kind: 'scale', rubric: 'Tighter rubric' }, T2);

		set(labour.id, { quality: 3 }, T3);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(false);
		expect(attributeOf('quality').stale).toBe(0);
	});

	it('counts only the stale values', () => {
		const other = newLabour();
		set(labour.id, { quality: 3 }, T1);
		define({ key: 'quality', kind: 'scale', rubric: 'Tighter rubric' }, T2);
		set(other.id, { quality: 4 }, T3);

		expect(attributeOf('quality')).toMatchObject({ held: 2, stale: 1 });
	});

	it('goes stale again on the next revision', () => {
		set(labour.id, { quality: 3 }, T1);
		define({ key: 'quality', kind: 'scale', rubric: 'v2' }, T2);
		set(labour.id, { quality: 3 }, T2);
		expect(valueOf(labour.id, 'quality')!.stale).toBe(false);

		define({ key: 'quality', kind: 'scale', rubric: 'v3' }, T3);

		expect(valueOf(labour.id, 'quality')!.stale).toBe(true);
	});
});

describe('Attribute held and counts across Labours', () => {
	it('count what Labours hold, and follow clears and replacements', () => {
		define(scale('quality', 1, 5));
		const [a, b, c] = [newLabour(), newLabour(), newLabour()];
		set(a.id, { quality: 3 });
		set(b.id, { quality: 3 });
		set(c.id, { quality: 5 });
		expect(attributeOf('quality')).toMatchObject({ held: 3, counts: { '3': 2, '5': 1 } });

		set(a.id, { quality: null });
		set(b.id, { quality: 1 });

		expect(attributeOf('quality')).toMatchObject({ held: 2, counts: { '1': 1, '5': 1 } });
	});
});

describe('the Realm version', () => {
	it('takes the first change from 0 to 1', () => {
		expect(versionOf()).toBe(0);

		define(scale('a'));

		expect(versionOf()).toBe(1);
	});

	it('rises by exactly one per call, however many things the call changes', () => {
		define(scale('a'));
		define(scale('b'));
		define(text('c'));
		const labour = newLabour();
		expect(versionOf()).toBe(3);

		set(labour.id, { a: 1, b: 2, c: 'three' });
		expect(versionOf()).toBe(4);

		tuneRealm(db, actor, realm.id, { notes: 'n', halfLifeDays: 7, loudness: 9 }, T1);
		expect(versionOf()).toBe(5);

		define(scale('a', 1, 4, { label: 'L2', rubric: 'R2', index: 2 }), T1);
		expect(versionOf()).toBe(6);

		deleteAttribute(db, actor, realm.id, 'c', T2);
		expect(versionOf()).toBe(7);
	});

	it('is the version returned by define and delete', () => {
		expect(define(scale('a')).version).toBe(1);
		expect(define(scale('b')).version).toBe(2);
		expect(deleteAttribute(db, actor, realm.id, 'a', T1).version).toBe(3);
	});

	it('does not bump for a call that changes nothing', () => {
		define(scale('a'));
		const labour = newLabour();
		set(labour.id, { a: 3 }, T0);
		tuneRealm(db, actor, realm.id, { notes: 'n' }, T0);
		const version = versionOf();

		define(scale('a'), T1);
		set(labour.id, {}, T1);
		set(newLabour().id, { a: null }, T1);
		tuneRealm(db, actor, realm.id, { notes: 'n' }, T1);
		tuneRealm(db, actor, realm.id, {}, T1);

		expect(versionOf()).toBe(version);
	});

	it('bumps when a value is re-set to the same content, since setBy and setAt are rewritten', () => {
		define(scale('a'));
		const labour = newLabour();
		set(labour.id, { a: 3 }, T0);
		const version = versionOf();

		set(labour.id, { a: 3 }, T1);

		expect(versionOf()).toBe(version + 1);
	});

	it('does not bump on a refused call', () => {
		define(scale('a'));
		const labour = newLabour();
		const version = versionOf();

		expectDomainError(() => set(labour.id, { a: 99 }), 'invalid');
		expectDomainError(() => define(scale('a', 5, 1), T1), 'invalid');
		expectDomainError(() => tuneRealm(db, actor, realm.id, { loudness: 0 }, T1), 'invalid');
		expectDomainError(() => deleteAttribute(db, actor, realm.id, 'zz', T1), 'not_found');

		expect(versionOf()).toBe(version);
	});

	it('counts per Realm', () => {
		const other = seedRealm(db, 'BL');

		define(scale('a'));
		define(scale('b'), T0, other.id);
		define(scale('c'), T0, other.id);

		expect([versionOf(realm.id), versionOf(other.id)]).toEqual([1, 2]);
	});

	it('is bumped by setting a value only in the Labour Realm', () => {
		const other = seedRealm(db, 'BL');
		define(scale('a'));
		define(scale('a'), T0, other.id);
		const labour = newLabour(realm.id);

		set(labour.id, { a: 3 });

		expect([versionOf(realm.id), versionOf(other.id)]).toEqual([2, 1]);
	});

	it('rises by one for a revise that also clamps many values', () => {
		define(scale('a', 1, 10));
		for (const n of [8, 9]) set(newLabour().id, { a: n });
		const version = versionOf();

		define(scale('a', 1, 5), T1);

		expect(versionOf()).toBe(version + 1);
	});
});

describe('tuneRealm', () => {
	const tune = (input: Record<string, unknown>, now = T1) =>
		tuneRealm(db, actor, realm.id, input, now);

	it('sets notes and both settings and returns the Realm agent view', () => {
		const view = tune({ notes: 'Be terse.', halfLifeDays: 30, loudness: 12 });

		expect(view).toEqual({ version: 1, notes: 'Be terse.', halfLifeDays: 30, loudness: 12 });
		expect(readRealmAgent(db, realm.id)).toEqual(view);
	});

	it('changes only what is given', () => {
		tune({ notes: 'Be terse.', halfLifeDays: 30, loudness: 12 });

		expect(tune({ loudness: 2 }, T2)).toEqual({
			version: 2,
			notes: 'Be terse.',
			halfLifeDays: 30,
			loudness: 2
		});
		expect(tune({ notes: '' }, T3)).toEqual({
			version: 3,
			notes: '',
			halfLifeDays: 30,
			loudness: 2
		});
	});

	it('stores notes as given, without trimming', () => {
		tune({ notes: '  padded \n' });

		expect(readRealmAgent(db, realm.id).notes).toBe('  padded \n');
	});

	it('accepts notes of 4000 characters and refuses 4001', () => {
		tune({ notes: chars(4000) });
		expect(readRealmAgent(db, realm.id).notes).toHaveLength(4000);

		expectDomainError(() => tune({ notes: chars(4001) }, T2), 'invalid');
		expect(readRealmAgent(db, realm.id).notes).toHaveLength(4000);
	});

	it('accepts halfLifeDays above 0 up to 365', () => {
		expect(tune({ halfLifeDays: 0.5 }).halfLifeDays).toBe(0.5);
		expect(tune({ halfLifeDays: 365 }, T2).halfLifeDays).toBe(365);
	});

	it.each([0, -1, 365.01, 366, Number.NaN, Number.POSITIVE_INFINITY, '14'])(
		'refuses halfLifeDays %s as invalid',
		(halfLifeDays) => {
			expectDomainError(() => tune({ halfLifeDays }), 'invalid');
			expect(readRealmAgent(db, realm.id)).toMatchObject({ halfLifeDays: 14, version: 0 });
		}
	);

	it('accepts loudness above 0 up to 1000', () => {
		expect(tune({ loudness: 0.1 }).loudness).toBe(0.1);
		expect(tune({ loudness: 1000 }, T2).loudness).toBe(1000);
	});

	it.each([0, -1, 1000.01, 1001, Number.NaN, Number.POSITIVE_INFINITY, '5'])(
		'refuses loudness %s as invalid',
		(loudness) => {
			expectDomainError(() => tune({ loudness }), 'invalid');
			expect(readRealmAgent(db, realm.id)).toMatchObject({ loudness: 5, version: 0 });
		}
	);

	it('refuses a non-string notes as invalid', () => {
		expectDomainError(() => tune({ notes: 12 }), 'invalid');
	});

	it('applies nothing when one field of the call is invalid', () => {
		expectDomainError(() => tune({ notes: 'fine', halfLifeDays: 10, loudness: 0 }), 'invalid');

		expect(readRealmAgent(db, realm.id)).toEqual({
			version: 0,
			notes: '',
			halfLifeDays: 14,
			loudness: 5
		});
	});

	it('does not bump when the call restates the current values, defaults included', () => {
		expect(tune({ halfLifeDays: 14, loudness: 5, notes: '' }).version).toBe(0);
		expect(tune({}).version).toBe(0);

		tune({ notes: 'x' }, T2);
		expect(tune({ notes: 'x', loudness: 5 }, T3).version).toBe(1);
	});

	it('keeps each Realm to its own settings', () => {
		const other = seedRealm(db, 'BL');

		tune({ notes: 'mine', loudness: 9 });

		expect(readRealmAgent(db, other.id)).toEqual({
			version: 0,
			notes: '',
			halfLifeDays: 14,
			loudness: 5
		});
	});

	it('leaves Attributes alone', () => {
		define(scale('a'));

		tune({ notes: 'n' });

		expect(attributeOf('a')).toMatchObject({ revisedAt: T0, updatedAt: T0 });
	});
});

describe('isolation from the board', () => {
	let labour: { id: number };

	beforeEach(() => {
		labour = newLabour();
	});

	it('records no Event and leaves labours.updatedAt alone for every kind of write', () => {
		quiet(() => define(scale('quality', 1, 10), T0));
		quiet(() => define(tags('area', ['a', 'b', 'c']), T0));
		quiet(() => define(text('note', 20), T0));
		quiet(() => define({ key: 'quality', kind: 'scale', rubric: 'Revised' }, T1));
		quiet(() => define({ key: 'quality', kind: 'scale', index: 2 }, T1));
		quiet(() => tuneRealm(db, actor, realm.id, { notes: 'n', halfLifeDays: 3, loudness: 8 }, T1));
		quiet(() => set(labour.id, { quality: 9, area: ['a', 'b'], note: 'hello' }, T1));
		quiet(() => set(labour.id, { quality: 4 }, T2));
		quiet(() => set(labour.id, { note: null }, T2));
		quiet(() => define(scale('quality', 1, 5), T3));
		quiet(() => define(tags('area', ['c']), T3));
		quiet(() => deleteAttribute(db, actor, realm.id, 'note', T3));
		quiet(() => deleteAttribute(db, actor, realm.id, 'quality', T3));

		expect(versionOf()).toBeGreaterThan(5);
	});

	it('leaves the board alone when a revise clamps values on many Labours', () => {
		define(scale('quality', 1, 10), T0);
		for (const n of [8, 9, 10]) set(newLabour().id, { quality: n });

		quiet(() => define(scale('quality', 1, 5), T1));

		expect(attributeOf('quality').counts).toEqual({ '5': 3 });
	});
});

describe('deleting a Labour or a Realm', () => {
	it('deletes the values of a deleted Labour and keeps the others', () => {
		define(scale('quality', 1, 5));
		const gone = newLabour();
		const kept = newLabour();
		set(gone.id, { quality: 2 });
		set(kept.id, { quality: 2 });

		deleteLabour(db, actor, gone.id);

		expect(attributeOf('quality')).toMatchObject({ held: 1, counts: { '2': 1 } });
		expect(readValues(db, kept.id)).toHaveLength(1);
	});

	it('removes the value rows of a deleted Labour', () => {
		define(scale('quality', 1, 5));
		const labour = newLabour();
		set(labour.id, { quality: 2 });
		const before = agentRows();

		deleteLabour(db, actor, labour.id);

		expect(before).toBeGreaterThan(0);
		expect(agentRows()).toBeLessThan(before);
	});

	it('deletes the Attributes, values and settings of a deleted Realm', () => {
		define(scale('quality', 1, 5));
		define(tags('area', ['a', 'b']));
		tuneRealm(db, actor, realm.id, { notes: 'n', loudness: 2 }, T1);
		set(newLabour().id, { quality: 2, area: ['a'] });
		set(newLabour().id, { quality: 4 });
		expect(agentRows()).toBeGreaterThan(0);

		deleteRealm(db, actor, realm.id);

		expect(agentRows()).toBe(0);
	});

	it('leaves other Realms agent data alone when a Realm is deleted', () => {
		const other = seedRealm(db, 'BL');
		define(scale('quality', 1, 5));
		define(scale('quality', 1, 5), T0, other.id);
		const theirs = newLabour(other.id);
		set(theirs.id, { quality: 3 });
		tuneRealm(db, actor, other.id, { notes: 'theirs' }, T1);

		deleteRealm(db, actor, realm.id);

		expect(readAttributes(db, other.id)).toHaveLength(1);
		expect(readValues(db, theirs.id)).toHaveLength(1);
		expect(readRealmAgent(db, other.id).notes).toBe('theirs');
	});
});

describe('moving a Labour to another Realm', () => {
	let other: { id: number };
	let ada: Actor;
	let labour: { id: number };

	beforeEach(() => {
		other = seedRealm(db, 'BL');
		ada = { id: seedUser(db, 'ada') };
		labour = newLabour();
	});

	const move = () => moveLabour(db, actor, labour.id, { realmId: other.id });
	const versions = () => [versionOf(realm.id), versionOf(other.id)];

	it('keeps a value under a same-keyed, same-kind Attribute with its original setBy and setAt', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('quality', 1, 5), T0, other.id);
		set(labour.id, { quality: 4 }, T1, ada);

		move();

		expect(valueOf(labour.id, 'quality')).toMatchObject({
			key: 'quality',
			kind: 'scale',
			value: 4,
			setBy: ada.id,
			via: null,
			setAt: T1
		});
		expect(attributeOf('quality', other.id)).toMatchObject({ held: 1, counts: { '4': 1 } });
		expect(attributeOf('quality', realm.id)).toMatchObject({ held: 0, counts: {} });
	});

	it('judges staleness against the new Attribute: set before its revisedAt is stale', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('quality', 1, 5), T2, other.id);
		set(labour.id, { quality: 4 }, T1);

		move();

		expect(valueOf(labour.id, 'quality')!.stale).toBe(true);
	});

	it('keeps a scale value at the edges of the new range, and does not clamp', () => {
		define(scale('low', 1, 10), T0);
		define(scale('high', 1, 10), T0);
		define(scale('out', 1, 10), T0);
		define(scale('low', 3, 7), T0, other.id);
		define(scale('high', 3, 7), T0, other.id);
		define(scale('out', 3, 7), T0, other.id);
		set(labour.id, { low: 3, high: 7, out: 9 }, T1, ada);

		move();

		expect(readValues(db, labour.id).map((v) => [v.key, v.value])).toEqual([
			['low', 3],
			['high', 7]
		]);
	});

	it('deletes a scale value below the new range', () => {
		define(scale('quality', 1, 10), T0);
		define(scale('quality', 5, 10), T0, other.id);
		set(labour.id, { quality: 2 });

		move();

		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('deletes a value whose Attribute has the same key but another kind', () => {
		define(scale('quality', 1, 5), T0);
		define(text('quality', 20), T0, other.id);
		set(labour.id, { quality: 3 });

		move();

		expect(readValues(db, labour.id)).toEqual([]);
		expect(attributeOf('quality', other.id).held).toBe(0);
	});

	it('deletes a value whose Attribute does not exist in the new Realm', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('different', 1, 5), T0, other.id);
		set(labour.id, { quality: 3 });

		move();

		expect(readValues(db, labour.id)).toEqual([]);
		expect(attributeOf('different', other.id).held).toBe(0);
	});

	it('keeps the members a tags value shares with the new Attribute, with the original setBy and setAt', () => {
		define(tags('area', ['a', 'b', 'c']), T0);
		define(tags('area', ['a', 'b', 'x']), T0, other.id);
		set(labour.id, { area: ['a', 'b', 'c'] }, T1, ada);

		move();

		expect(valueOf(labour.id, 'area')).toMatchObject({
			value: ['a', 'b'],
			setBy: ada.id,
			via: null,
			setAt: T1
		});
		expect(attributeOf('area', other.id).counts).toEqual({ a: 1, b: 1, x: 0 });
	});

	it('deletes a tags value when none of its members exist in the new Attribute', () => {
		define(tags('area', ['a', 'b']), T0);
		define(tags('area', ['x', 'y']), T0, other.id);
		set(labour.id, { area: ['a', 'b'] });

		move();

		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('deletes a tags value over the new max', () => {
		define(tags('area', ['a', 'b', 'c']), T0);
		define(tags('area', ['a', 'b', 'c'], 2), T0, other.id);
		set(labour.id, { area: ['a', 'b', 'c'] });

		move();

		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('keeps a tags value at the new max, and counts the max after dropping members', () => {
		define(tags('exact', ['a', 'b', 'c']), T0);
		define(tags('dropped', ['a', 'b', 'c']), T0);
		define(tags('exact', ['a', 'b', 'c'], 2), T0, other.id);
		define(tags('dropped', ['a', 'b'], 2), T0, other.id);
		set(labour.id, { exact: ['a', 'b'], dropped: ['a', 'b', 'c'] });

		move();

		expect(readValues(db, labour.id).map((v) => [v.key, v.value])).toEqual([
			['exact', ['a', 'b']],
			['dropped', ['a', 'b']]
		]);
	});

	it('keeps text within the new max and deletes text over it', () => {
		define(text('fits', 50), T0);
		define(text('exact', 50), T0);
		define(text('over', 50), T0);
		define(text('fits', 50), T0, other.id);
		define(text('exact', 5), T0, other.id);
		define(text('over', 4), T0, other.id);
		set(labour.id, { fits: 'hello world', exact: 'hello', over: 'hello' }, T1, ada);

		move();

		expect(readValues(db, labour.id).map((v) => [v.key, v.value, v.setBy, v.setAt])).toEqual([
			['fits', 'hello world', ada.id, T1],
			['exact', 'hello', ada.id, T1]
		]);
	});

	it('returns values in position order of the new Realm', () => {
		define(scale('a', 1, 5), T0);
		define(scale('b', 1, 5), T0);
		define(scale('b', 1, 5), T0, other.id);
		define(scale('a', 1, 5), T0, other.id);
		set(labour.id, { a: 1, b: 2 });

		move();

		expect(readValues(db, labour.id).map((v) => v.key)).toEqual(['b', 'a']);
	});

	it('does not touch the values of other Labours in either Realm', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('quality', 1, 5), T0, other.id);
		const stay = newLabour(realm.id);
		const there = newLabour(other.id);
		set(stay.id, { quality: 1 }, T1);
		set(there.id, { quality: 2 }, T1);
		set(labour.id, { quality: 3 }, T1);

		move();

		expect(valueOf(stay.id, 'quality')).toMatchObject({ value: 1, setAt: T1 });
		expect(valueOf(there.id, 'quality')).toMatchObject({ value: 2, setAt: T1 });
		expect(attributeOf('quality', other.id)).toMatchObject({ held: 2 });
		expect(attributeOf('quality', realm.id)).toMatchObject({ held: 1 });
	});

	it('bumps both Realms when a value is carried over', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('quality', 1, 5), T0, other.id);
		set(labour.id, { quality: 3 });
		const before = versions();

		move();

		expect(versions()).toEqual([before[0] + 1, before[1] + 1]);
	});

	it('bumps both Realms when a value is deleted by the move', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('other', 1, 5), T0, other.id);
		set(labour.id, { quality: 3 });
		const before = versions();

		move();

		expect(versions()).toEqual([before[0] + 1, before[1] + 1]);
	});

	it('bumps each Realm by exactly one, however many values move', () => {
		define(scale('a', 1, 5), T0);
		define(scale('b', 1, 5), T0);
		define(scale('a', 1, 5), T0, other.id);
		set(labour.id, { a: 1, b: 2 });
		const before = versions();

		move();

		expect(versions()).toEqual([before[0] + 1, before[1] + 1]);
	});

	it('bumps neither Realm when the Labour holds no values', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('quality', 1, 5), T0, other.id);
		const before = versions();

		move();

		expect(versions()).toEqual(before);
	});

	it('bumps neither Realm when neither has any agent data', () => {
		move();

		expect(versions()).toEqual([0, 0]);
	});

	it('still records its own labour.moved Event, and no other', () => {
		define(scale('quality', 1, 5), T0);
		define(scale('quality', 1, 5), T0, other.id);
		set(labour.id, { quality: 3 });
		const before = db.select().from(events).all().length;

		move();

		const recorded = db.select().from(events).all().slice(before);
		expect(recorded.map((e) => e.type)).toEqual(['labour.moved']);
	});

	it('changes no values when the move itself is refused', () => {
		define(scale('quality', 1, 5), T0);
		set(labour.id, { quality: 3 });
		const version = versionOf();

		expectDomainError(() => moveLabour(db, actor, labour.id, { realmId: 9999 }), 'not_found');

		expect(valueOf(labour.id, 'quality')!.value).toBe(3);
		expect(versionOf()).toBe(version);
	});
});
