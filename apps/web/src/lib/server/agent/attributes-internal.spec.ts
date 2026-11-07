import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { attributes, events, labourAttributes, labours } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { moveLabour } from '#lib/server/domain/labours.ts';
import { deleteRealm } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb, expectFailure } from '#lib/server/test/db.ts';
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
import { transact } from '#lib/server/db/tx.ts';

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
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

async function code(action: () => unknown): Promise<string> {
	try {
		await action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const eventCount = async () => (await db.select().from(events)).length;
const version = async (id = realmId) => (await readRealmAgent(db, id)).version;

describe('schema', () => {
	const insert = (over: Record<string, unknown>) => {
		const row = { realm_id: realmId, key: 'a', kind: 'scale', spec: '{}', position: 0, ...over };
		return db.$client.query(
			`INSERT INTO attributes (realm_id, key, kind, label, rubric, spec, position, created_at, revised_at, updated_at)
			 VALUES ($1, $2, $3, 'l', 'r', $4, $5, 0, 0, 0)`,
			[row.realm_id, row.key, row.kind, row.spec, row.position]
		);
	};

	it('refuses a malformed key, an unknown kind and invalid spec JSON', async () => {
		await expectFailure(insert({ key: 'Bad' }), /attributes_key_format/);
		await expectFailure(insert({ key: '1a' }), /attributes_key_format/);
		await expectFailure(insert({ key: 'a'.repeat(33) }), /attributes_key_format/);
		await expectFailure(insert({ kind: 'rank' }), /attributes_kind/);
		await expectFailure(insert({ spec: '{nope' }), /invalid input syntax for type json/);
		await expect(insert({})).resolves.toBeDefined();
	});

	it('allows a negative position and refuses a repeated one', async () => {
		await insert({ key: 'a', position: -1 });
		await expectFailure(insert({ key: 'b', position: -1 }), /attributes_realm_position_uq/);
	});

	it('refuses realm_agent values outside their bounds', async () => {
		const put = (version: number, half: number, loud: number) =>
			db.$client.query(
				'INSERT INTO realm_agent (realm_id, version, half_life_days, loudness, updated_at) VALUES ($1, $2, $3, $4, 0)',
				[realmId, version, half, loud]
			);
		await expectFailure(put(0, 14, 5), /realm_agent_version/);
		await expectFailure(put(1, 0, 5), /realm_agent_half_life/);
		await expectFailure(put(1, 366, 5), /realm_agent_half_life/);
		await expectFailure(put(1, 14, 0), /realm_agent_loudness/);
		await expect(put(1, 365, 0.5)).resolves.toBeDefined();
	});

	it('keeps a value inside its Labour and Attribute of one Realm', async () => {
		const other = (await seedRealm(db, 'OT')).id;
		const labour = await seedLabour(db, { realmId: other });
		await scale('size');
		const attribute = (await db.select().from(attributes).limit(1))[0]!;
		await expectFailure(
			db.insert(labourAttributes).values({
				realmId: other,
				labourId: labour.id,
				attributeId: attribute.id,
				value: 3,
				setBy: actor.id
			}),
			/labour_attributes_realm_id_attribute_id/
		);
	});

	it('deletes values with their Labour, their Attribute and their Realm', async () => {
		await scale('size');
		await tags('area', ['ui', 'api']);
		const a = await seedLabour(db, { realmId });
		const b = await seedLabour(db, { realmId });
		await setValues(db, actor, a.id, { size: 3, area: ['ui'] });
		await setValues(db, actor, b.id, { size: 4, area: ['api'] });
		const held = async () => (await db.select().from(labourAttributes)).length;
		expect(await held()).toBe(4);

		await db.delete(labours).where(eq(labours.id, a.id));
		expect(await held()).toBe(2);
		await deleteAttribute(db, actor, realmId, 'area');
		expect(await held()).toBe(1);
		await deleteRealm(db, actor, realmId);
		expect(await held()).toBe(0);
		expect(await db.select().from(attributes)).toEqual([]);
	});
});

describe('moving a Labour', () => {
	it('lets the move through the composite key and carries what the target accepts', async () => {
		const target = (await seedRealm(db, 'OT')).id;
		await scale('size', 1, 5);
		await scale('risk', 1, 5);
		await tags('area', ['ui', 'api']);
		await text('why');
		const at = (t: number, key: string, kind: 'scale' | 'tags' | 'text', spec: object) =>
			defineAttribute(db, actor, t, { key, kind, label: key, rubric, spec });
		await at(target, 'size', 'scale', { min: 1, max: 3 });
		await at(target, 'risk', 'scale', { min: 1, max: 5 });
		await at(target, 'area', 'tags', { members: [{ key: 'ui', label: 'ui' }] });
		await at(target, 'why', 'tags', { members: [{ key: 'x', label: 'x' }] });

		const labour = await seedLabour(db, { realmId });
		const early = new Date('2026-01-01T00:00:00Z');
		await setValues(
			db,
			actor,
			labour.id,
			{ size: 4, risk: 2, area: ['ui', 'api'], why: 'because' },
			early
		);
		const before = await version(realmId);
		const targetBefore = await version(target);

		await moveLabour(db, actor, labour.id, { realmId: target });

		const kept = await readValues(db, labour.id);
		expect(kept.map((v) => [v.key, v.value])).toEqual([
			['risk', 2],
			['area', ['ui']]
		]);
		expect(kept.every((v) => v.setAt.getTime() === early.getTime())).toBe(true);
		expect((await db.select().from(labourAttributes)).every((r) => r.realmId === target)).toBe(
			true
		);
		expect(await version(realmId)).toBe(before + 1);
		expect(await version(target)).toBe(targetBefore + 1);
	});

	it('leaves versions alone when the Labour holds no values', async () => {
		const target = (await seedRealm(db, 'OT')).id;
		const labour = await seedLabour(db, { realmId });
		await moveLabour(db, actor, labour.id, { realmId: target });
		expect(await version(realmId)).toBe(0);
		expect(await version(target)).toBe(0);
	});

	it('still records its own labour.moved Event and no other', async () => {
		const target = (await seedRealm(db, 'OT')).id;
		await scale('size');
		const labour = await seedLabour(db, { realmId });
		await setValues(db, actor, labour.id, { size: 2 });
		const before = await eventCount();
		await moveLabour(db, actor, labour.id, { realmId: target });
		const recorded = (await db.select().from(events)).slice(before);
		expect(recorded.map((e) => e.type)).toEqual(['labour.moved']);
	});
});

describe('versions', () => {
	it('bumps once for a Handle-level write of many Labours, through bumpRealms', async () => {
		await scale('size');
		const ids = await Promise.all(
			[1, 2, 3].map(async () => (await seedLabour(db, { realmId })).id)
		);
		const now = new Date();
		await transact(db, async (tx) => {
			const touched = new Set<number>();
			for (const id of ids) {
				await writeValues(tx, actor.id, { id, realmId }, { size: 3 }, now, touched);
			}
			expect(await version()).toBe(1);
			await bumpRealms(tx, touched, now);
		});
		expect(await version()).toBe(2);
	});

	it('adds no Realm to touched when a clear finds nothing to remove', async () => {
		await scale('size');
		const labour = await seedLabour(db, { realmId });
		const touched = new Set<number>();
		await transact(db, (tx) =>
			writeValues(tx, actor.id, labour, { size: null }, new Date(), touched)
		);
		expect(touched.size).toBe(0);
	});

	it('rolls the whole transaction back when one entry is bad', async () => {
		await scale('size');
		await text('why');
		const labour = await seedLabour(db, { realmId });
		const before = await version();
		expect(await code(() => setValues(db, actor, labour.id, { size: 3, why: 5 }))).toBe('invalid');
		expect(await readValues(db, labour.id)).toEqual([]);
		expect(await version()).toBe(before);
	});

	it('bumps for a tune that changes something, not for one that changes nothing', async () => {
		expect(await version()).toBe(0);
		await tuneRealm(db, actor, realmId, { notes: '', loudness: 5 });
		expect(await version()).toBe(0);
		await tuneRealm(db, actor, realmId, { notes: 'hello', halfLifeDays: 30 });
		expect(await readRealmAgent(db, realmId)).toEqual({
			version: 1,
			notes: 'hello',
			halfLifeDays: 30,
			loudness: 5
		});
		await tuneRealm(db, actor, realmId, { notes: 'hello' });
		expect(await version()).toBe(1);
	});

	it('refuses tune values out of bounds', async () => {
		expect(await code(() => tuneRealm(db, actor, realmId, { halfLifeDays: 0 }))).toBe('invalid');
		expect(await code(() => tuneRealm(db, actor, realmId, { halfLifeDays: 366 }))).toBe('invalid');
		expect(await code(() => tuneRealm(db, actor, realmId, { loudness: 1001 }))).toBe('invalid');
		expect(await code(() => tuneRealm(db, actor, realmId, { notes: 'x'.repeat(4001) }))).toBe(
			'invalid'
		);
		expect(await code(() => tuneRealm(db, actor, 999, { notes: 'x' }))).toBe('not_found');
	});

	it('records no Event and leaves labours.updated_at alone', async () => {
		const labour = await seedLabour(db, { realmId });
		const stamp = (await db.select().from(labours).where(eq(labours.id, labour.id)).limit(1))[0]!
			.updatedAt;
		const before = await eventCount();
		await scale('size');
		await setValues(db, actor, labour.id, { size: 2 });
		await tuneRealm(db, actor, realmId, { notes: 'n' });
		await deleteAttribute(db, actor, realmId, 'size');
		expect(await eventCount()).toBe(before);
		expect(
			(await db.select().from(labours).where(eq(labours.id, labour.id)).limit(1))[0]!.updatedAt
		).toEqual(stamp);
	});
});

describe('attributes', () => {
	it('creates, orders by index and packs positions on delete', async () => {
		await scale('a');
		await scale('b');
		const { attribute } = await defineAttribute(db, actor, realmId, {
			key: 'c',
			kind: 'text',
			label: 'c',
			rubric,
			index: 0
		});
		expect(attribute.spec).toEqual({ max: 2000 });
		expect((await readAttributes(db, realmId)).map((a) => [a.key, a.position])).toEqual([
			['c', 0],
			['a', 1],
			['b', 2]
		]);
		await deleteAttribute(db, actor, realmId, 'a');
		expect((await readAttributes(db, realmId)).map((a) => [a.key, a.position])).toEqual([
			['c', 0],
			['b', 1]
		]);
	});

	it('reorders by index when the key exists, and refuses an index out of range', async () => {
		await scale('a');
		await scale('b');
		await scale('c');
		const reorder = (index: number) =>
			defineAttribute(db, actor, realmId, { key: 'c', kind: 'scale', index });
		await reorder(0);
		expect((await readAttributes(db, realmId)).map((a) => a.key)).toEqual(['c', 'a', 'b']);
		expect(await code(() => reorder(3))).toBe('invalid');
		expect(await code(() => reorder(-1))).toBe('invalid');
	});

	it('refuses reserved and malformed keys, a changed kind and a 33rd Attribute', async () => {
		const make = (key: string, kind: 'scale' | 'text' = 'text') =>
			defineAttribute(db, actor, realmId, { key, kind, label: 'l', rubric });
		expect(await code(() => make('rank'))).toBe('invalid');
		expect(await code(() => make('skill_fit'))).toBe('invalid');
		expect(await code(() => make('Bad'))).toBe('invalid');
		await make('ok');
		expect(await code(() => make('ok', 'scale'))).toBe('invalid');
		for (let i = 1; i < 32; i++) await make(`a${i}`);
		expect(await code(() => make('one-more'))).toBe('conflict');
	});

	it('refuses a spec field the kind does not have and a bad spec', async () => {
		const make = (kind: 'scale' | 'tags' | 'text', spec: object) =>
			defineAttribute(db, actor, realmId, { key: 'x', kind, label: 'l', rubric, spec });
		expect(await code(() => make('scale', { min: 1, max: 5, members: [] }))).toBe('invalid');
		expect(await code(() => make('scale', { min: 5, max: 5 }))).toBe('invalid');
		expect(await code(() => make('scale', { min: 0, max: 101 }))).toBe('invalid');
		expect(await code(() => make('scale', { min: 0.5, max: 3 }))).toBe('invalid');
		expect(await code(() => make('tags', { members: [] }))).toBe('invalid');
		expect(await code(() => make('tags', { members: [{ key: 'a', label: 'a' }], max: 0 }))).toBe(
			'invalid'
		);
		expect(
			await code(() =>
				make('tags', {
					members: [
						{ key: 'a', label: 'a' },
						{ key: 'a', label: 'b' }
					]
				})
			)
		).toBe('invalid');
		expect(await code(() => make('text', { max: 20_001 }))).toBe('invalid');
		expect(await code(() => make('text', { min: 1 }))).toBe('invalid');
		expect(await readAttributes(db, realmId)).toEqual([]);
	});

	it('moves revisedAt only when the rubric or spec changes', async () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const t1 = new Date('2026-01-02T00:00:00Z');
		const t2 = new Date('2026-01-03T00:00:00Z');
		const t3 = new Date('2026-01-04T00:00:00Z');
		const redefine = async (over: object, at: Date) =>
			(
				await defineAttribute(
					db,
					actor,
					realmId,
					{ key: 'size', kind: 'scale', label: 'Size', rubric, spec: { min: 1, max: 5 }, ...over },
					at
				)
			).attribute;
		await defineAttribute(
			db,
			actor,
			realmId,
			{ key: 'size', kind: 'scale', label: 'Size', rubric, spec: { min: 1, max: 5 } },
			t0
		);
		expect(await version()).toBe(1);
		expect((await redefine({}, t1)).updatedAt).toEqual(t0);
		expect(await version()).toBe(1);
		const relabelled = await redefine({ label: 'Bigness' }, t2);
		expect([relabelled.revisedAt, relabelled.updatedAt]).toEqual([t0, t2]);
		const respecced = await redefine({ spec: { min: 1, max: 7 } }, t3);
		expect([respecced.revisedAt, respecced.updatedAt]).toEqual([t3, t3]);
		expect(await version()).toBe(3);
	});

	it('clamps scale values on narrowing and keeps setBy and setAt', async () => {
		await scale('size', 1, 10);
		const labour = await seedLabour(db, { realmId });
		const early = new Date('2026-01-01T00:00:00Z');
		await setValues(db, actor, labour.id, { size: 9 }, early);
		await defineAttribute(db, actor, realmId, {
			key: 'size',
			kind: 'scale',
			spec: { min: 1, max: 5 }
		});
		const [value] = await readValues(db, labour.id);
		expect(value.value).toBe(5);
		expect(value.setAt).toEqual(early);
		expect(value.stale).toBe(true);
		expect((await readAttributes(db, realmId))[0]).toMatchObject({
			held: 1,
			stale: 1,
			counts: { '5': 1 }
		});
	});

	it('removes members from values and deletes a value left empty', async () => {
		await tags('area', ['ui', 'api', 'db']);
		const a = await seedLabour(db, { realmId });
		const b = await seedLabour(db, { realmId });
		await setValues(db, actor, a.id, { area: ['db', 'ui'] });
		await setValues(db, actor, b.id, { area: ['api'] });
		await defineAttribute(db, actor, realmId, {
			key: 'area',
			kind: 'tags',
			spec: {
				members: [
					{ key: 'ui', label: 'ui' },
					{ key: 'db', label: 'db' }
				]
			}
		});
		expect((await readValues(db, a.id))[0].value).toEqual(['db', 'ui']);
		expect(await readValues(db, b.id)).toEqual([]);
		expect((await readAttributes(db, realmId))[0].counts).toEqual({ ui: 1, db: 1 });
	});

	it('refuses a lowered max below a held value and changes nothing', async () => {
		await tags('area', ['ui', 'api', 'db']);
		await text('why', 100);
		const labour = await seedLabour(db, { realmId });
		await setValues(db, actor, labour.id, { area: ['db', 'ui'], why: 'twelve chars' });
		const before = await version();
		expect(
			await code(() =>
				defineAttribute(db, actor, realmId, { key: 'area', kind: 'tags', spec: { max: 1 } })
			)
		).toBe('conflict');
		expect(
			await code(() =>
				defineAttribute(db, actor, realmId, { key: 'why', kind: 'text', spec: { max: 5 } })
			)
		).toBe('conflict');
		expect(await version()).toBe(before);
		expect((await readAttributes(db, realmId)).map((a) => a.spec)).toEqual([
			{ members: expect.any(Array), max: null },
			{ max: 100 }
		]);
	});
});

describe('values', () => {
	it('normalizes tags, text and clears, and rewrites setBy and setAt on every write', async () => {
		await tags('area', ['ui', 'api']);
		await text('why', 10);
		await scale('size');
		const labour = await seedLabour(db, { realmId });
		const first = new Date('2026-01-01T00:00:00Z');
		const second = new Date('2026-01-02T00:00:00Z');
		await setValues(
			db,
			actor,
			labour.id,
			{ area: ['ui', 'api', 'ui'], why: '  hi  ', size: 2 },
			first
		);
		expect((await readValues(db, labour.id)).map((v) => v.value)).toEqual([['api', 'ui'], 'hi', 2]);
		await setValues(db, actor, labour.id, { size: 2 }, second);
		expect((await readValues(db, labour.id)).find((v) => v.key === 'size')!.setAt).toEqual(second);
		await setValues(db, actor, labour.id, { area: [], why: '   ', size: null }, second);
		expect(await readValues(db, labour.id)).toEqual([]);
	});

	it('refuses a bad value, an unknown key and an unknown Labour', async () => {
		await tags('area', ['ui'], 1);
		await scale('size');
		await text('why', 3);
		const labour = await seedLabour(db, { realmId });
		for (const values of [
			{ size: 6 },
			{ size: 2.5 },
			{ size: '3' },
			{ area: ['nope'] },
			{ area: 'ui' },
			{ why: 'long' },
			{ ghost: 1 }
		]) {
			expect(await code(() => setValues(db, actor, labour.id, values))).toBe('invalid');
		}
		expect(await code(() => setValues(db, actor, 999, { size: 1 }))).toBe('not_found');
	});

	it('reads an unknown Labour as holding nothing', async () => {
		expect(await readValues(db, 999)).toEqual([]);
	});

	it('counts a stale value until it is set again', async () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const t1 = new Date('2026-01-02T00:00:00Z');
		const t2 = new Date('2026-01-03T00:00:00Z');
		await scale('size');
		const labour = await seedLabour(db, { realmId });
		await setValues(db, actor, labour.id, { size: 3 }, t0);
		await defineAttribute(db, actor, realmId, { key: 'size', kind: 'scale', rubric: 'New.' }, t1);
		expect((await readAttributes(db, realmId))[0].stale).toBe(1);
		await setValues(db, actor, labour.id, { size: 3 }, t2);
		expect((await readAttributes(db, realmId))[0].stale).toBe(0);
	});
});
