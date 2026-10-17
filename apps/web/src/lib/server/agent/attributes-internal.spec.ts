import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { attributes, events, labourAttributes, labours } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { moveLabour } from '#lib/server/domain/labours.ts';
import { deleteRealm } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import {
	bumpRealms,
	defineAttribute,
	deleteAttribute,
	readAttributes,
	readRealmAgent,
	readValues,
	setValues,
	tuneRealm,
	writeValues
} from './attributes.ts';

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realmId = seedRealm(db, 'AM').id;
});

afterEach(() => {
	db.$client.close();
});

const rubric = 'Judge it.';
const scale = (key: string, min = 1, max = 5) =>
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'scale',
		label: key,
		rubric,
		spec: { min, max }
	});
const tags = (key: string, members: string[], max?: number | null) =>
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'tags',
		label: key,
		rubric,
		spec: { members: members.map((m) => ({ key: m, label: m })), max }
	});
const text = (key: string, max?: number) =>
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'text',
		label: key,
		rubric,
		spec: max === undefined ? undefined : { max }
	});

function code(action: () => unknown): string {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const eventCount = () => db.select().from(events).all().length;
const version = (id = realmId) => readRealmAgent(db, id).version;

describe('schema', () => {
	const insert = (over: Record<string, unknown>) =>
		db.$client
			.prepare(
				`INSERT INTO attributes (realm_id, key, kind, label, rubric, spec, position, created_at, revised_at, updated_at)
				 VALUES (@realm_id, @key, @kind, 'l', 'r', @spec, @position, 0, 0, 0)`
			)
			.run({ realm_id: realmId, key: 'a', kind: 'scale', spec: '{}', position: 0, ...over });

	it('refuses a malformed key, an unknown kind and invalid spec JSON', () => {
		expect(() => insert({ key: 'Bad' })).toThrow(/CHECK/);
		expect(() => insert({ key: '1a' })).toThrow(/CHECK/);
		expect(() => insert({ key: 'a'.repeat(33) })).toThrow(/CHECK/);
		expect(() => insert({ kind: 'rank' })).toThrow(/CHECK/);
		expect(() => insert({ spec: '{nope' })).toThrow(/CHECK/);
		expect(() => insert({})).not.toThrow();
	});

	it('allows a negative position and refuses a repeated one', () => {
		insert({ key: 'a', position: -1 });
		expect(() => insert({ key: 'b', position: -1 })).toThrow(/UNIQUE/);
	});

	it('refuses realm_agent values outside their bounds', () => {
		const put = (version: number, half: number, loud: number) =>
			db.$client
				.prepare(
					'INSERT INTO realm_agent (realm_id, version, half_life_days, loudness, updated_at) VALUES (?, ?, ?, ?, 0)'
				)
				.run(realmId, version, half, loud);
		expect(() => put(0, 14, 5)).toThrow(/CHECK/);
		expect(() => put(1, 0, 5)).toThrow(/CHECK/);
		expect(() => put(1, 366, 5)).toThrow(/CHECK/);
		expect(() => put(1, 14, 0)).toThrow(/CHECK/);
		expect(() => put(1, 365, 0.5)).not.toThrow();
	});

	it('keeps a value inside its Labour and Attribute of one Realm', () => {
		const other = seedRealm(db, 'OT').id;
		const labour = seedLabour(db, { realmId: other });
		scale('size');
		const attribute = db.select().from(attributes).get()!;
		expect(() =>
			db
				.insert(labourAttributes)
				.values({
					realmId: other,
					labourId: labour.id,
					attributeId: attribute.id,
					value: 3,
					setBy: actor.id
				})
				.run()
		).toThrow(/FOREIGN KEY/);
	});

	it('deletes values with their Labour, their Attribute and their Realm', () => {
		scale('size');
		tags('area', ['ui', 'api']);
		const a = seedLabour(db, { realmId });
		const b = seedLabour(db, { realmId });
		setValues(db, actor, a.id, { size: 3, area: ['ui'] });
		setValues(db, actor, b.id, { size: 4, area: ['api'] });
		const held = () => db.select().from(labourAttributes).all().length;
		expect(held()).toBe(4);

		db.delete(labours).where(eq(labours.id, a.id)).run();
		expect(held()).toBe(2);
		deleteAttribute(db, actor, realmId, 'area');
		expect(held()).toBe(1);
		deleteRealm(db, actor, realmId);
		expect(held()).toBe(0);
		expect(db.select().from(attributes).all()).toEqual([]);
	});
});

describe('moving a Labour', () => {
	it('lets the move through the composite key and carries what the target accepts', () => {
		const target = seedRealm(db, 'OT').id;
		scale('size', 1, 5);
		scale('risk', 1, 5);
		tags('area', ['ui', 'api']);
		text('why');
		const at = (t: number, key: string, kind: 'scale' | 'tags' | 'text', spec: object) =>
			defineAttribute(db, actor, t, { key, kind, label: key, rubric, spec });
		at(target, 'size', 'scale', { min: 1, max: 3 });
		at(target, 'risk', 'scale', { min: 1, max: 5 });
		at(target, 'area', 'tags', { members: [{ key: 'ui', label: 'ui' }] });
		at(target, 'why', 'tags', { members: [{ key: 'x', label: 'x' }] });

		const labour = seedLabour(db, { realmId });
		const early = new Date('2026-01-01T00:00:00Z');
		setValues(
			db,
			actor,
			labour.id,
			{ size: 4, risk: 2, area: ['ui', 'api'], why: 'because' },
			early
		);
		const before = version(realmId);
		const targetBefore = version(target);

		moveLabour(db, actor, labour.id, { realmId: target });

		const kept = readValues(db, labour.id);
		expect(kept.map((v) => [v.key, v.value])).toEqual([
			['risk', 2],
			['area', ['ui']]
		]);
		expect(kept.every((v) => v.setAt.getTime() === early.getTime())).toBe(true);
		expect(
			db
				.select()
				.from(labourAttributes)
				.all()
				.every((r) => r.realmId === target)
		).toBe(true);
		expect(version(realmId)).toBe(before + 1);
		expect(version(target)).toBe(targetBefore + 1);
	});

	it('leaves versions alone when the Labour holds no values', () => {
		const target = seedRealm(db, 'OT').id;
		const labour = seedLabour(db, { realmId });
		moveLabour(db, actor, labour.id, { realmId: target });
		expect(version(realmId)).toBe(0);
		expect(version(target)).toBe(0);
	});

	it('still records its own labour.moved Event and no other', () => {
		const target = seedRealm(db, 'OT').id;
		scale('size');
		const labour = seedLabour(db, { realmId });
		setValues(db, actor, labour.id, { size: 2 });
		const before = eventCount();
		moveLabour(db, actor, labour.id, { realmId: target });
		const recorded = db.select().from(events).all().slice(before);
		expect(recorded.map((e) => e.type)).toEqual(['labour.moved']);
	});
});

describe('versions', () => {
	it('bumps once for a Handle-level write of many Labours, through bumpRealms', () => {
		scale('size');
		const ids = [1, 2, 3].map(() => seedLabour(db, { realmId }).id);
		const now = new Date();
		db.transaction((tx) => {
			const touched = new Set<number>();
			for (const id of ids) {
				writeValues(tx, actor.id, { id, realmId }, { size: 3 }, now, touched);
			}
			expect(version()).toBe(1);
			bumpRealms(tx, touched, now);
		});
		expect(version()).toBe(2);
	});

	it('adds no Realm to touched when a clear finds nothing to remove', () => {
		scale('size');
		const labour = seedLabour(db, { realmId });
		const touched = new Set<number>();
		db.transaction((tx) => writeValues(tx, actor.id, labour, { size: null }, new Date(), touched));
		expect(touched.size).toBe(0);
	});

	it('rolls the whole transaction back when one entry is bad', () => {
		scale('size');
		text('why');
		const labour = seedLabour(db, { realmId });
		const before = version();
		expect(code(() => setValues(db, actor, labour.id, { size: 3, why: 5 }))).toBe('invalid');
		expect(readValues(db, labour.id)).toEqual([]);
		expect(version()).toBe(before);
	});

	it('bumps for a tune that changes something, not for one that changes nothing', () => {
		expect(version()).toBe(0);
		tuneRealm(db, actor, realmId, { notes: '', loudness: 5 });
		expect(version()).toBe(0);
		tuneRealm(db, actor, realmId, { notes: 'hello', halfLifeDays: 30 });
		expect(readRealmAgent(db, realmId)).toEqual({
			version: 1,
			notes: 'hello',
			halfLifeDays: 30,
			loudness: 5
		});
		tuneRealm(db, actor, realmId, { notes: 'hello' });
		expect(version()).toBe(1);
	});

	it('refuses tune values out of bounds', () => {
		expect(code(() => tuneRealm(db, actor, realmId, { halfLifeDays: 0 }))).toBe('invalid');
		expect(code(() => tuneRealm(db, actor, realmId, { halfLifeDays: 366 }))).toBe('invalid');
		expect(code(() => tuneRealm(db, actor, realmId, { loudness: 1001 }))).toBe('invalid');
		expect(code(() => tuneRealm(db, actor, realmId, { notes: 'x'.repeat(4001) }))).toBe('invalid');
		expect(code(() => tuneRealm(db, actor, 999, { notes: 'x' }))).toBe('not_found');
	});

	it('records no Event and leaves labours.updated_at alone', () => {
		const labour = seedLabour(db, { realmId });
		const stamp = db.select().from(labours).where(eq(labours.id, labour.id)).get()!.updatedAt;
		const before = eventCount();
		scale('size');
		setValues(db, actor, labour.id, { size: 2 });
		tuneRealm(db, actor, realmId, { notes: 'n' });
		deleteAttribute(db, actor, realmId, 'size');
		expect(eventCount()).toBe(before);
		expect(db.select().from(labours).where(eq(labours.id, labour.id)).get()!.updatedAt).toEqual(
			stamp
		);
	});
});

describe('attributes', () => {
	it('creates, orders by index and packs positions on delete', () => {
		scale('a');
		scale('b');
		const { attribute } = defineAttribute(db, actor, realmId, {
			key: 'c',
			kind: 'text',
			label: 'c',
			rubric,
			index: 0
		});
		expect(attribute.spec).toEqual({ max: 2000 });
		expect(readAttributes(db, realmId).map((a) => [a.key, a.position])).toEqual([
			['c', 0],
			['a', 1],
			['b', 2]
		]);
		deleteAttribute(db, actor, realmId, 'a');
		expect(readAttributes(db, realmId).map((a) => [a.key, a.position])).toEqual([
			['c', 0],
			['b', 1]
		]);
	});

	it('reorders by index when the key exists, and refuses an index out of range', () => {
		scale('a');
		scale('b');
		scale('c');
		const reorder = (index: number) =>
			defineAttribute(db, actor, realmId, { key: 'c', kind: 'scale', index });
		reorder(0);
		expect(readAttributes(db, realmId).map((a) => a.key)).toEqual(['c', 'a', 'b']);
		expect(code(() => reorder(3))).toBe('invalid');
		expect(code(() => reorder(-1))).toBe('invalid');
	});

	it('refuses reserved and malformed keys, a changed kind and a 33rd Attribute', () => {
		const make = (key: string, kind: 'scale' | 'text' = 'text') =>
			defineAttribute(db, actor, realmId, { key, kind, label: 'l', rubric });
		expect(code(() => make('rank'))).toBe('invalid');
		expect(code(() => make('skill_fit'))).toBe('invalid');
		expect(code(() => make('Bad'))).toBe('invalid');
		make('ok');
		expect(code(() => make('ok', 'scale'))).toBe('invalid');
		for (let i = 1; i < 32; i++) make(`a${i}`);
		expect(code(() => make('one-more'))).toBe('conflict');
	});

	it('refuses a spec field the kind does not have and a bad spec', () => {
		const make = (kind: 'scale' | 'tags' | 'text', spec: object) =>
			defineAttribute(db, actor, realmId, { key: 'x', kind, label: 'l', rubric, spec });
		expect(code(() => make('scale', { min: 1, max: 5, members: [] }))).toBe('invalid');
		expect(code(() => make('scale', { min: 5, max: 5 }))).toBe('invalid');
		expect(code(() => make('scale', { min: 0, max: 101 }))).toBe('invalid');
		expect(code(() => make('scale', { min: 0.5, max: 3 }))).toBe('invalid');
		expect(code(() => make('tags', { members: [] }))).toBe('invalid');
		expect(code(() => make('tags', { members: [{ key: 'a', label: 'a' }], max: 0 }))).toBe(
			'invalid'
		);
		expect(
			code(() =>
				make('tags', {
					members: [
						{ key: 'a', label: 'a' },
						{ key: 'a', label: 'b' }
					]
				})
			)
		).toBe('invalid');
		expect(code(() => make('text', { max: 20_001 }))).toBe('invalid');
		expect(code(() => make('text', { min: 1 }))).toBe('invalid');
		expect(readAttributes(db, realmId)).toEqual([]);
	});

	it('moves revisedAt only when the rubric or spec changes', () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const t1 = new Date('2026-01-02T00:00:00Z');
		const t2 = new Date('2026-01-03T00:00:00Z');
		const t3 = new Date('2026-01-04T00:00:00Z');
		const redefine = (over: object, at: Date) =>
			defineAttribute(
				db,
				actor,
				realmId,
				{ key: 'size', kind: 'scale', label: 'Size', rubric, spec: { min: 1, max: 5 }, ...over },
				at
			).attribute;
		defineAttribute(
			db,
			actor,
			realmId,
			{ key: 'size', kind: 'scale', label: 'Size', rubric, spec: { min: 1, max: 5 } },
			t0
		);
		expect(version()).toBe(1);
		expect(redefine({}, t1).updatedAt).toEqual(t0);
		expect(version()).toBe(1);
		const relabelled = redefine({ label: 'Bigness' }, t2);
		expect([relabelled.revisedAt, relabelled.updatedAt]).toEqual([t0, t2]);
		const respecced = redefine({ spec: { min: 1, max: 7 } }, t3);
		expect([respecced.revisedAt, respecced.updatedAt]).toEqual([t3, t3]);
		expect(version()).toBe(3);
	});

	it('clamps scale values on narrowing and keeps setBy and setAt', () => {
		scale('size', 1, 10);
		const labour = seedLabour(db, { realmId });
		const early = new Date('2026-01-01T00:00:00Z');
		setValues(db, actor, labour.id, { size: 9 }, early);
		defineAttribute(db, actor, realmId, { key: 'size', kind: 'scale', spec: { min: 1, max: 5 } });
		const [value] = readValues(db, labour.id);
		expect(value.value).toBe(5);
		expect(value.setAt).toEqual(early);
		expect(value.stale).toBe(true);
		expect(readAttributes(db, realmId)[0]).toMatchObject({ held: 1, stale: 1, counts: { '5': 1 } });
	});

	it('removes members from values and deletes a value left empty', () => {
		tags('area', ['ui', 'api', 'db']);
		const a = seedLabour(db, { realmId });
		const b = seedLabour(db, { realmId });
		setValues(db, actor, a.id, { area: ['db', 'ui'] });
		setValues(db, actor, b.id, { area: ['api'] });
		defineAttribute(db, actor, realmId, {
			key: 'area',
			kind: 'tags',
			spec: {
				members: [
					{ key: 'ui', label: 'ui' },
					{ key: 'db', label: 'db' }
				]
			}
		});
		expect(readValues(db, a.id)[0].value).toEqual(['db', 'ui']);
		expect(readValues(db, b.id)).toEqual([]);
		expect(readAttributes(db, realmId)[0].counts).toEqual({ ui: 1, db: 1 });
	});

	it('refuses a lowered max below a held value and changes nothing', () => {
		tags('area', ['ui', 'api', 'db']);
		text('why', 100);
		const labour = seedLabour(db, { realmId });
		setValues(db, actor, labour.id, { area: ['db', 'ui'], why: 'twelve chars' });
		const before = version();
		expect(
			code(() =>
				defineAttribute(db, actor, realmId, { key: 'area', kind: 'tags', spec: { max: 1 } })
			)
		).toBe('conflict');
		expect(
			code(() =>
				defineAttribute(db, actor, realmId, { key: 'why', kind: 'text', spec: { max: 5 } })
			)
		).toBe('conflict');
		expect(version()).toBe(before);
		expect(readAttributes(db, realmId).map((a) => a.spec)).toEqual([
			{ members: expect.any(Array), max: null },
			{ max: 100 }
		]);
	});
});

describe('values', () => {
	it('normalizes tags, text and clears, and rewrites setBy and setAt on every write', () => {
		tags('area', ['ui', 'api']);
		text('why', 10);
		scale('size');
		const labour = seedLabour(db, { realmId });
		const first = new Date('2026-01-01T00:00:00Z');
		const second = new Date('2026-01-02T00:00:00Z');
		setValues(db, actor, labour.id, { area: ['ui', 'api', 'ui'], why: '  hi  ', size: 2 }, first);
		expect(readValues(db, labour.id).map((v) => v.value)).toEqual([['api', 'ui'], 'hi', 2]);
		setValues(db, actor, labour.id, { size: 2 }, second);
		expect(readValues(db, labour.id).find((v) => v.key === 'size')!.setAt).toEqual(second);
		setValues(db, actor, labour.id, { area: [], why: '   ', size: null }, second);
		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('refuses a bad value, an unknown key and an unknown Labour', () => {
		tags('area', ['ui'], 1);
		scale('size');
		text('why', 3);
		const labour = seedLabour(db, { realmId });
		for (const values of [
			{ size: 6 },
			{ size: 2.5 },
			{ size: '3' },
			{ area: ['nope'] },
			{ area: 'ui' },
			{ why: 'long' },
			{ ghost: 1 }
		]) {
			expect(code(() => setValues(db, actor, labour.id, values))).toBe('invalid');
		}
		expect(code(() => setValues(db, actor, 999, { size: 1 }))).toBe('not_found');
	});

	it('reads an unknown Labour as holding nothing', () => {
		expect(readValues(db, 999)).toEqual([]);
	});

	it('counts a stale value until it is set again', () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const t1 = new Date('2026-01-02T00:00:00Z');
		const t2 = new Date('2026-01-03T00:00:00Z');
		scale('size');
		const labour = seedLabour(db, { realmId });
		setValues(db, actor, labour.id, { size: 3 }, t0);
		defineAttribute(db, actor, realmId, { key: 'size', kind: 'scale', rubric: 'New.' }, t1);
		expect(readAttributes(db, realmId)[0].stale).toBe(1);
		setValues(db, actor, labour.id, { size: 3 }, t2);
		expect(readAttributes(db, realmId)[0].stale).toBe(0);
	});
});
