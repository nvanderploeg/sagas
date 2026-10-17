import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours, pulses, realmAgent } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { defineAttribute, deleteAttribute, readRealmAgent, tuneRealm } from './attributes.ts';
import {
	deletePulse,
	filePulses,
	postPulses,
	prunePulses,
	readSentiment,
	type PulseInput
} from './sentiment.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let db: Db;
let actor: Actor;
let realm: { id: number };
let perfId: number;
let bugsId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realm = seedRealm(db, 'AM');
	perfId = define({ key: 'perf', kind: 'scale', spec: { min: 0, max: 4 } });
	bugsId = define({
		key: 'bugs',
		kind: 'tags',
		spec: {
			members: [
				{ key: 'crash', label: 'Crash' },
				{ key: 'lag', label: 'Lag' },
				{ key: 'hang', label: 'Hang' }
			]
		}
	});
	define({ key: 'notes', kind: 'text' });
});

afterEach(() => {
	db.$client.close();
});

function define(input: {
	key: string;
	kind: 'scale' | 'tags' | 'text';
	spec?: Parameters<typeof defineAttribute>[3]['spec'];
}): number {
	return defineAttribute(
		db,
		actor,
		realm.id,
		{ label: input.key, rubric: `About ${input.key}`, ...input },
		NOW
	).attribute.id;
}

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

const pulse = (key: string, extra: Partial<PulseInput> = {}): PulseInput => ({
	key,
	amount: 1,
	mood: 0,
	...extra
});

const post = (items: PulseInput[], at = NOW, by = actor) => postPulses(db, by, realm.id, items, at);

const postOne = (item: PulseInput, at = NOW) => post([item], at)[0].id;

const rows = () => db.select().from(pulses).all();
const rowOf = (id: number) => rows().find((row) => row.id === id)!;
const read = (opts: { limit?: number; now?: Date } = {}) =>
	readSentiment(db, realm.id, { now: NOW, ...opts });
const keysOf = (view: ReturnType<typeof read>) => view.keys.map((k) => k.key);

describe('postPulses keys', () => {
	it('files a bare key that names a scale Attribute', () => {
		const [result] = post([pulse('perf')]);

		expect(result.status).toBe('filed');
		expect(rowOf(result.id).attributeId).toBe(perfId);
		expect(keysOf(read())).toEqual(['perf']);
	});

	it('files attr:member when attr is a tags Attribute with that member', () => {
		const [result] = post([pulse('bugs:crash')]);

		expect(result.status).toBe('filed');
		expect(rowOf(result.id)).toMatchObject({ attributeId: bugsId, member: 'crash' });
		expect(keysOf(read())).toEqual(['bugs:crash']);
	});

	it('lowercases and trims the key and keeps it as rawKey', () => {
		const [scale, member] = post([pulse('  PERF '), pulse(' Bugs:Crash')]);

		expect(scale.status).toBe('filed');
		expect(member.status).toBe('filed');
		expect(rowOf(scale.id).rawKey).toBe('perf');
		expect(rowOf(member.id).rawKey).toBe('bugs:crash');
	});

	it.each([
		['an unknown Attribute', 'ghost'],
		['a bare tags key', 'bugs'],
		['a bare text key', 'notes'],
		['a member of a scale', 'perf:high'],
		['an unknown member of a tags Attribute', 'bugs:nope'],
		['a member of a text Attribute', 'notes:any'],
		['a member of an unknown Attribute', 'ghost:crash']
	])('keeps %s unfiled', (_name, key) => {
		const [result] = post([pulse(key)]);

		expect(result.status).toBe('unfiled');
		expect(rowOf(result.id)).toMatchObject({ rawKey: key, attributeId: null });
		expect(read().keys).toEqual([]);
		expect(read().unfiled.map((entry) => entry.rawKey)).toEqual([key]);
	});

	it.each([
		['empty', ''],
		['blank', '   '],
		['starting with a digit', '1abc'],
		['starting with a hyphen', '-abc'],
		['with an underscore', 'a_b'],
		['with a space', 'bad key'],
		['with an empty member', 'bugs:'],
		['with an empty attribute', ':crash'],
		['with two colons', 'bugs:crash:x'],
		['with an over-long attribute part', `a${'b'.repeat(32)}`],
		['with an over-long member part', `bugs:a${'b'.repeat(32)}`]
	])('refuses a key that is %s', (_name, key) => {
		expectDomainError(() => post([pulse(key)]), 'invalid');
		expect(rows()).toEqual([]);
	});

	it('accepts a key part of exactly 32 characters', () => {
		const part = `a${'b'.repeat(31)}`;

		const [bare, member] = post([pulse(part), pulse(`${part}:${part}`)]);

		expect([bare.status, member.status]).toEqual(['unfiled', 'unfiled']);
	});

	it('refuses an unknown Realm', () => {
		expectDomainError(() => postPulses(db, actor, 9999, [pulse('perf')], NOW), 'not_found');
	});
});

describe('postPulses writing', () => {
	it('records the fields of each Pulse, createdAt being now', () => {
		const labour = seedLabour(db, { realmId: realm.id });

		const [result] = post([
			pulse('perf', {
				amount: 2.5,
				mood: -0.25,
				note: '  slow on load  ',
				evidence: [{ href: 'https://example.com/t/1', label: 'thread' }, { labour: labour.id }],
				halfLifeDays: 30,
				ref: 'post-1'
			})
		]);

		expect(rowOf(result.id)).toMatchObject({
			realmId: realm.id,
			userId: null,
			rawKey: 'perf',
			amount: 2.5,
			mood: -0.25,
			halfLifeDays: 30,
			note: 'slow on load',
			ref: 'post-1',
			authorId: actor.id,
			createdAt: NOW
		});
	});

	it('records the author who posted', () => {
		const bob = seedUser(db, 'bob');

		const [result] = post([pulse('perf')], NOW, { id: bob });

		expect(rowOf(result.id).authorId).toBe(bob);
	});

	it('stores an absent note as the empty string', () => {
		const [result] = post([pulse('perf')]);

		expect(rowOf(result.id).note).toBe('');
	});

	it('reports each item by index, status and the id of its Pulse', () => {
		const result = post([pulse('perf'), pulse('ghost'), pulse('bugs:lag')]);

		expect(result).toEqual([
			{ index: 0, status: 'filed', id: expect.any(Number) },
			{ index: 1, status: 'unfiled', id: expect.any(Number) },
			{ index: 2, status: 'filed', id: expect.any(Number) }
		]);
		expect(rows().map((row) => row.id)).toEqual(result.map((r) => r.id));
		expect(new Set(result.map((r) => r.id)).size).toBe(3);
	});

	it('writes the Pulses of a batch with the same createdAt', () => {
		post([pulse('perf'), pulse('ghost')]);

		expect(rows().map((row) => row.createdAt)).toEqual([NOW, NOW]);
	});

	it('defaults now to the current time', () => {
		const before = Date.now();
		const [result] = postPulses(db, actor, realm.id, [pulse('perf')]);
		const after = Date.now();

		const at = rowOf(result.id).createdAt.getTime();
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(after);
	});
});

describe('postPulses validation', () => {
	it.each([
		['an amount of zero', { amount: 0 }],
		['a negative amount', { amount: -1 }],
		['an amount above 10', { amount: 10.0001 }],
		['a NaN amount', { amount: NaN }],
		['an infinite amount', { amount: Infinity }],
		['a mood below -1', { mood: -1.0001 }],
		['a mood above 1', { mood: 1.0001 }],
		['a NaN mood', { mood: NaN }],
		['a note over 1,000 characters', { note: 'n'.repeat(1001) }],
		['more than 10 pieces of evidence', { evidence: Array(11).fill({ href: 'https://a.test' }) }],
		['evidence with an empty href', { evidence: [{ href: '' }] }],
		['evidence with a blank href', { evidence: [{ href: '   ' }] }],
		['evidence with an href over 500 characters', { evidence: [{ href: 'h'.repeat(501) }] }],
		[
			'evidence with a label over 120 characters',
			{ evidence: [{ href: 'https://a.test', label: 'l'.repeat(121) }] }
		],
		['evidence naming neither an href nor a Labour', { evidence: [{}] }],
		['a half-life of zero', { halfLifeDays: 0 }],
		['a negative half-life', { halfLifeDays: -1 }],
		['a half-life above 365', { halfLifeDays: 365.0001 }],
		['a NaN half-life', { halfLifeDays: NaN }],
		['an empty ref', { ref: '' }],
		['a blank ref', { ref: '   ' }],
		['a ref over 200 characters', { ref: 'r'.repeat(201) }]
	] as [string, Partial<PulseInput>][])('refuses %s and writes nothing', (_name, patch) => {
		expectDomainError(() => post([pulse('perf', patch)]), 'invalid');
		expect(rows()).toEqual([]);
	});

	it.each([
		['the largest amount', { amount: 10 }],
		['a tiny amount', { amount: 0.001 }],
		['mood -1', { mood: -1 }],
		['mood 1', { mood: 1 }],
		['mood 0', { mood: 0 }],
		['a note of 1,000 characters', { note: 'n'.repeat(1000) }],
		['a note of 1,000 characters between spaces', { note: ` ${'n'.repeat(1000)} ` }],
		['10 pieces of evidence', { evidence: Array(10).fill({ href: 'https://a.test' }) }],
		['an href of 500 characters', { evidence: [{ href: 'h'.repeat(500) }] }],
		['an href of 500 characters between spaces', { evidence: [{ href: ` ${'h'.repeat(500)} ` }] }],
		[
			'a label of 120 characters',
			{ evidence: [{ href: 'https://a.test', label: 'l'.repeat(120) }] }
		],
		['a half-life of 365', { halfLifeDays: 365 }],
		['a tiny half-life', { halfLifeDays: 0.001 }],
		['a half-life of null', { halfLifeDays: null }],
		['a ref of 200 characters', { ref: 'r'.repeat(200) }]
	] as [string, Partial<PulseInput>][])('accepts %s', (_name, patch) => {
		const [result] = post([pulse('perf', patch)]);

		expect(result.status).toBe('filed');
	});

	it('accepts 50 items and refuses 51', () => {
		expectDomainError(
			() => post(Array.from({ length: 51 }, (_, i) => pulse('perf', { ref: `r${i}` }))),
			'invalid'
		);
		expect(rows()).toEqual([]);

		const written = post(Array.from({ length: 50 }, (_, i) => pulse('perf', { ref: `r${i}` })));

		expect(written).toHaveLength(50);
		expect(rows()).toHaveLength(50);
	});

	it('refuses an empty batch', () => {
		expectDomainError(() => post([]), 'invalid');
	});

	it('trims the href, and a label that is empty after trimming becomes null', () => {
		const labelled = { href: '  https://a.test/x  ', label: '  thread  ' };
		const blank = { href: 'https://b.test', label: '   ' };
		const bare = { href: 'https://c.test' };
		const nulled = { href: 'https://d.test', label: null };
		postOne(pulse('perf', { evidence: [labelled, blank, bare, nulled] }));

		expect(read().keys[0].pulses[0].evidence).toEqual([
			{ href: 'https://a.test/x', label: 'thread' },
			{ href: 'https://b.test', label: null },
			{ href: 'https://c.test', label: null },
			{ href: 'https://d.test', label: null }
		]);
	});

	it('refuses evidence naming a Labour that does not exist as not_found and writes nothing', () => {
		expectDomainError(() => post([pulse('perf', { evidence: [{ labour: 9999 }] })]), 'not_found');
		expect(rows()).toEqual([]);
	});

	it('keeps evidence in the order given, Labours by id', () => {
		const first = seedLabour(db, { realmId: realm.id });
		const second = seedLabour(db, { realmId: realm.id });
		postOne(
			pulse('perf', {
				evidence: [{ labour: second.id }, { href: 'https://a.test' }, { labour: first.id }]
			})
		);

		expect(read().keys[0].pulses[0].evidence).toEqual([
			{ labour: second.id },
			{ href: 'https://a.test', label: null },
			{ labour: first.id }
		]);
	});

	it('writes nothing when a later item is invalid', () => {
		expectDomainError(
			() => post([pulse('perf', { ref: 'r1' }), pulse('ghost'), pulse('perf', { amount: 11 })]),
			'invalid'
		);
		expect(rows()).toEqual([]);
	});

	it('writes nothing when a later item names a missing evidence Labour', () => {
		expectDomainError(
			() => post([pulse('perf'), pulse('bugs:lag', { evidence: [{ labour: 9999 }] })]),
			'not_found'
		);
		expect(rows()).toEqual([]);
	});

	it('does not let a refused batch claim a ref', () => {
		expectDomainError(() => post([pulse('perf', { ref: 'r1' }), pulse('x_y')]), 'invalid');

		const [result] = post([pulse('perf', { ref: 'r1' })]);

		expect(result.status).toBe('filed');
	});
});

describe('postPulses half-life', () => {
	it('defaults to 14 days in a Realm that was never tuned', () => {
		const id = postOne(pulse('perf'));

		expect(rowOf(id).halfLifeDays).toBe(14);
	});

	it('takes the half-life of the Realm at write time and keeps it when the Realm is tuned later', () => {
		tuneRealm(db, actor, realm.id, { halfLifeDays: 7 }, NOW);
		const id = postOne(pulse('perf', { amount: 2 }), ago(7));

		tuneRealm(db, actor, realm.id, { halfLifeDays: 30 }, NOW);

		expect(rowOf(id).halfLifeDays).toBe(7);
		expect(read().keys[0].pulses[0].weight).toBeCloseTo(1, 10);
	});

	it('prefers the half-life given over the Realm', () => {
		tuneRealm(db, actor, realm.id, { halfLifeDays: 7 }, NOW);

		const id = postOne(pulse('perf', { halfLifeDays: 3 }));

		expect(rowOf(id).halfLifeDays).toBe(3);
	});

	it('stores null for a Pulse that never fades, whatever the Realm half-life', () => {
		tuneRealm(db, actor, realm.id, { halfLifeDays: 7 }, NOW);

		const id = postOne(pulse('perf', { amount: 2, halfLifeDays: null }), ago(1000));

		expect(rowOf(id).halfLifeDays).toBeNull();
		expect(read().keys[0].pulses[0].weight).toBe(2);
	});
});

describe('postPulses ref', () => {
	it('skips an item whose ref the same author already used with the same key', () => {
		const first = postOne(pulse('perf', { ref: 'm-1', note: 'original' }));

		const [result] = post([pulse('perf', { ref: 'm-1', note: 'repeat', amount: 9 })]);

		expect(result).toEqual({ index: 0, status: 'skipped', id: first });
		expect(rows()).toHaveLength(1);
		expect(rowOf(first)).toMatchObject({ note: 'original', amount: 1 });
	});

	it('skips a repeat of an unfiled key as well', () => {
		const first = postOne(pulse('ghost', { ref: 'm-1' }));

		const [result] = post([pulse('ghost', { ref: 'm-1' })]);

		expect(result).toEqual({ index: 0, status: 'skipped', id: first });
	});

	it('skips a repeat within one batch and points at the Pulse written earlier in it', () => {
		const result = post([
			pulse('perf', { ref: 'm-1' }),
			pulse('perf', { ref: 'm-1', note: 'again' })
		]);

		expect(result.map((r) => r.status)).toEqual(['filed', 'skipped']);
		expect(result[1].id).toBe(result[0].id);
		expect(rows()).toHaveLength(1);
	});

	it('keeps indexes of items around a skipped one', () => {
		const first = postOne(pulse('perf', { ref: 'm-1' }));

		const result = post([pulse('bugs:lag'), pulse('perf', { ref: 'm-1' }), pulse('ghost')]);

		expect(result.map((r) => [r.index, r.status])).toEqual([
			[0, 'filed'],
			[1, 'skipped'],
			[2, 'unfiled']
		]);
		expect(result[1].id).toBe(first);
		expect(rows()).toHaveLength(3);
	});

	it('compares the key and the ref after normalising them', () => {
		const first = postOne(pulse('perf', { ref: 'm-1' }));

		const [result] = post([pulse(' PERF ', { ref: '  m-1  ' })]);

		expect(result).toEqual({ index: 0, status: 'skipped', id: first });
	});

	it('writes an item with the same ref under another key', () => {
		post([pulse('perf', { ref: 'm-1' })]);

		const [result] = post([pulse('bugs:lag', { ref: 'm-1' })]);

		expect(result.status).toBe('filed');
		expect(rows()).toHaveLength(2);
	});

	it('writes an item with another ref under the same key', () => {
		post([pulse('perf', { ref: 'm-1' })]);

		const [result] = post([pulse('perf', { ref: 'm-2' })]);

		expect(result.status).toBe('filed');
	});

	it('writes an item with the same ref and key from another author', () => {
		const bob = { id: seedUser(db, 'bob') };
		post([pulse('perf', { ref: 'm-1' })]);

		const [result] = post([pulse('perf', { ref: 'm-1' })], NOW, bob);

		expect(result.status).toBe('filed');
		expect(rows()).toHaveLength(2);
	});

	it('never skips items without a ref', () => {
		post([pulse('perf')]);

		const result = post([pulse('perf'), pulse('perf')]);

		expect(result.map((r) => r.status)).toEqual(['filed', 'filed']);
		expect(rows()).toHaveLength(3);
	});

	it('still skips after the earlier Pulse was filed under another key', () => {
		const first = postOne(pulse('slow', { ref: 'm-1' }));
		filePulses(db, actor, realm.id, 'slow', 'perf');

		const [result] = post([pulse('slow', { ref: 'm-1' })]);

		expect(result).toEqual({ index: 0, status: 'skipped', id: first });
	});

	it('writes the item again once the earlier Pulse is deleted', () => {
		const first = postOne(pulse('perf', { ref: 'm-1' }));
		deletePulse(db, actor, first);

		const [result] = post([pulse('perf', { ref: 'm-1' })]);

		expect(result.status).toBe('filed');
		expect(result.id).not.toBe(first);
	});
});

describe('readSentiment', () => {
	function seedPerf() {
		const a = postOne(pulse('perf', { amount: 2, mood: -1, note: 'a' }), ago(14));
		const b = postOne(pulse('perf', { amount: 4, mood: 1, note: 'b' }), ago(28));
		const c = postOne(pulse('perf', { amount: 1.5, mood: 0.5, note: 'c', halfLifeDays: null }));
		return { a, b, c };
	}

	it('weighs each Pulse as amount × 2^(−age / half-life), or the amount without a half-life', () => {
		const { a, b, c } = seedPerf();

		const [key] = read().keys;

		expect(key.pulses.map((p) => [p.id, p.weight])).toEqual([
			[c, 1.5],
			[a, 1],
			[b, 1]
		]);
	});

	it('weighs a Pulse by a fractional number of half-lives', () => {
		postOne(pulse('perf', { amount: 2 }), ago(7));

		expect(read().keys[0].pulses[0].weight).toBeCloseTo(Math.SQRT2, 10);
	});

	it('sums volume, averages mood by weight, and sets v from the Realm loudness', () => {
		seedPerf();

		const [key] = read().keys;

		expect(key.realmId).toBe(realm.id);
		expect(key.key).toBe('perf');
		expect(key.volume).toBeCloseTo(3.5, 10);
		expect(key.mood).toBeCloseTo(0.75 / 3.5, 10);
		expect(key.v).toBeCloseTo(3.5 / (3.5 + 5), 10);
	});

	it('uses the loudness of the Realm', () => {
		seedPerf();
		tuneRealm(db, actor, realm.id, { loudness: 1.5 }, NOW);

		expect(read().keys[0].v).toBeCloseTo(3.5 / 5, 10);
	});

	it('echoes the time it was read at', () => {
		expect(read().asOf).toEqual(NOW);
	});

	it('defaults now to the current time', () => {
		postOne(pulse('perf', { amount: 2, halfLifeDays: null }), new Date());

		const before = Date.now();
		const view = readSentiment(db, realm.id);
		const after = Date.now();

		expect(view.asOf.getTime()).toBeGreaterThanOrEqual(before);
		expect(view.asOf.getTime()).toBeLessThanOrEqual(after);
	});

	it('weighs less as now moves on', () => {
		postOne(pulse('perf', { amount: 4 }));

		expect(readSentiment(db, realm.id, { now: NOW }).keys[0].volume).toBe(4);
		expect(readSentiment(db, realm.id, { now: ago(-14) }).keys[0].volume).toBe(2);
		expect(readSentiment(db, realm.id, { now: ago(-28) }).keys[0].volume).toBe(1);
	});

	it('never counts a negative age', () => {
		postOne(pulse('perf', { amount: 2 }), new Date(NOW.getTime() + 10 * DAY));

		const [key] = read().keys;

		expect(key.pulses[0].weight).toBe(2);
		expect(key.volume).toBe(2);
	});

	it('lists the fields of a Pulse', () => {
		const labour = seedLabour(db, { realmId: realm.id });
		const bob = seedUser(db, 'bob');
		const id = postOne(
			pulse('perf', { note: 'hello', evidence: [{ labour: labour.id }] }),
			ago(14)
		);
		const other = postPulses(db, { id: bob }, realm.id, [pulse('perf', { amount: 0.001 })], NOW);

		const listed = read().keys[0].pulses;

		expect(listed).toEqual([
			{
				id,
				note: 'hello',
				evidence: [{ labour: labour.id }],
				authorId: actor.id,
				createdAt: ago(14),
				weight: 0.5
			},
			{
				id: other[0].id,
				note: '',
				evidence: [],
				authorId: bob,
				createdAt: NOW,
				weight: 0.001
			}
		]);
	});

	it('leaves out evidence that names a deleted Labour', () => {
		const kept = seedLabour(db, { realmId: realm.id });
		const gone = seedLabour(db, { realmId: realm.id });
		postOne(
			pulse('perf', {
				evidence: [{ labour: gone.id }, { href: 'https://a.test' }, { labour: kept.id }]
			})
		);

		deleteLabour(db, actor, gone.id);

		expect(read().keys[0].pulses[0].evidence).toEqual([
			{ href: 'https://a.test', label: null },
			{ labour: kept.id }
		]);
	});

	describe('ordering and limit', () => {
		it('orders keys by volume descending, then by key', () => {
			define({ key: 'aaa', kind: 'scale', spec: { min: 0, max: 4 } });
			post([
				pulse('bugs:lag', { halfLifeDays: null }),
				pulse('aaa', { amount: 0.5, halfLifeDays: null }),
				pulse('bugs:crash', { halfLifeDays: null }),
				pulse('perf', { amount: 3, halfLifeDays: null })
			]);

			expect(keysOf(read())).toEqual(['perf', 'bugs:crash', 'bugs:lag', 'aaa']);
		});

		it('orders by decayed volume, not by amount', () => {
			post([pulse('perf', { amount: 8 }), pulse('bugs:lag', { amount: 3 })], ago(28));
			post([pulse('bugs:crash', { amount: 3 })]);

			const view = read();

			expect(keysOf(view)).toEqual(['bugs:crash', 'perf', 'bugs:lag']);
			expect(view.keys.map((k) => k.volume)).toEqual([3, 2, 0.75]);
		});

		it('lists only filed keys that have a Pulse', () => {
			post([pulse('bugs:hang'), pulse('ghost')]);

			expect(keysOf(read())).toEqual(['bugs:hang']);
		});

		it('is empty for a Realm without Pulses', () => {
			const view = read();

			expect(view.keys).toEqual([]);
			expect(view.unfiled).toEqual([]);
		});

		it('lists three Pulses of a key by default, heaviest first', () => {
			const light = postOne(pulse('perf', { amount: 1, halfLifeDays: null }));
			const heavy = postOne(pulse('perf', { amount: 5, halfLifeDays: null }));
			const middle = postOne(pulse('perf', { amount: 3, halfLifeDays: null }));
			const lightest = postOne(pulse('perf', { amount: 0.5, halfLifeDays: null }));

			const [key] = read().keys;

			expect(key.pulses.map((p) => p.id)).toEqual([heavy, middle, light]);
			expect(key.pulses.map((p) => p.id)).not.toContain(lightest);
		});

		it('breaks a tie of weight by newest first', () => {
			const older = postOne(pulse('perf', { amount: 2, halfLifeDays: null }), ago(3));
			const newest = postOne(pulse('perf', { amount: 2, halfLifeDays: null }), ago(1));
			const middle = postOne(pulse('perf', { amount: 2, halfLifeDays: null }), ago(2));

			expect(read().keys[0].pulses.map((p) => p.id)).toEqual([newest, middle, older]);
		});

		it('honours limit, and limit changes only the Pulses listed', () => {
			seedPerf();

			const one = read({ limit: 1 }).keys[0];
			const all = read({ limit: 20 }).keys[0];

			expect(one.pulses).toHaveLength(1);
			expect(all.pulses).toHaveLength(3);
			expect(one.volume).toBeCloseTo(3.5, 10);
			expect(one.mood).toBeCloseTo(all.mood, 10);
			expect(one.v).toBeCloseTo(all.v, 10);
		});

		it('lists up to 20 Pulses', () => {
			post(Array.from({ length: 25 }, () => pulse('perf')));

			expect(read({ limit: 20 }).keys[0].pulses).toHaveLength(20);
			expect(read().keys[0].pulses).toHaveLength(3);
		});

		it.each([0, 21, 1.5, -1, NaN])('refuses a limit of %s', (limit) => {
			expectDomainError(() => read({ limit }), 'invalid');
		});
	});

	describe('unfiled', () => {
		it('lists one entry per unfiled rawKey with its volume, count and newest Pulse', () => {
			post([pulse('ghost', { note: 'older' })], ago(14));
			const newest = postOne(pulse('ghost', { amount: 2, note: 'newer' }));
			post([pulse('bugs', { amount: 4, halfLifeDays: null })]);
			post([pulse('NOTES', { amount: 4, halfLifeDays: null })]);

			expect(read().unfiled).toEqual([
				{ rawKey: 'bugs', volume: 4, count: 1, newest: { id: expect.any(Number), note: '' } },
				{ rawKey: 'notes', volume: 4, count: 1, newest: { id: expect.any(Number), note: '' } },
				{ rawKey: 'ghost', volume: 2.5, count: 2, newest: { id: newest, note: 'newer' } }
			]);
		});

		it('leaves filed Pulses out', () => {
			post([pulse('perf'), pulse('ghost')]);

			expect(read().unfiled.map((entry) => entry.rawKey)).toEqual(['ghost']);
		});

		it('leaves out the Pulses of other Realms', () => {
			const other = seedRealm(db, 'BL');
			postPulses(db, actor, other.id, [pulse('ghost'), pulse('perf')], NOW);
			post([pulse('mine')]);

			const view = read();

			expect(view.unfiled.map((entry) => entry.rawKey)).toEqual(['mine']);
			expect(view.keys).toEqual([]);
			expect(readSentiment(db, other.id, { now: NOW }).unfiled.map((e) => e.rawKey)).toEqual([
				'ghost',
				'perf'
			]);
		});
	});
});

describe('filePulses', () => {
	it('files unfiled Pulses under a key the Realm now has, keeping their rawKey', () => {
		const ids = post([pulse('speed', { amount: 2 }), pulse('speed', { amount: 3 })]).map(
			(r) => r.id
		);
		define({ key: 'speed', kind: 'scale', spec: { min: 0, max: 4 } });
		expect(read().keys).toEqual([]);

		const moved = filePulses(db, actor, realm.id, 'speed', 'speed');

		expect(moved).toBe(2);
		expect(keysOf(read())).toEqual(['speed']);
		expect(read().unfiled).toEqual([]);
		expect(ids.map((id) => rowOf(id).rawKey)).toEqual(['speed', 'speed']);
	});

	it('files under another key than the rawKey', () => {
		const slow = postOne(pulse('slow', { amount: 2 }));
		const sluggish = postOne(pulse('slow:down', { amount: 1 }));

		const moved = filePulses(db, actor, realm.id, 'slow', 'perf');

		expect(moved).toBe(1);
		expect(rowOf(slow)).toMatchObject({ attributeId: perfId, rawKey: 'slow' });
		expect(rowOf(sluggish).attributeId).toBeNull();
		expect(read().unfiled.map((entry) => entry.rawKey)).toEqual(['slow:down']);
	});

	it('files under a member of a tags Attribute', () => {
		const id = postOne(pulse('crashes'));

		filePulses(db, actor, realm.id, 'crashes', 'bugs:crash');

		expect(rowOf(id)).toMatchObject({ attributeId: bugsId, member: 'crash', rawKey: 'crashes' });
		expect(keysOf(read())).toEqual(['bugs:crash']);
	});

	it('moves Pulses already filed under the key to another key', () => {
		const direct = postOne(pulse('perf', { amount: 2, halfLifeDays: null }));
		const refiled = postOne(pulse('slow', { amount: 3, halfLifeDays: null }));
		filePulses(db, actor, realm.id, 'slow', 'perf');
		expect(read().keys[0].volume).toBe(5);

		const moved = filePulses(db, actor, realm.id, 'perf', 'bugs:lag');

		expect(moved).toBe(2);
		const view = read();
		expect(keysOf(view)).toEqual(['bugs:lag']);
		expect(view.keys[0].volume).toBe(5);
		expect(rowOf(direct)).toMatchObject({ rawKey: 'perf', member: 'lag', attributeId: bugsId });
		expect(rowOf(refiled).rawKey).toBe('slow');
	});

	it('moves unfiled and filed Pulses of the same key in one call', () => {
		const unfiled = postOne(pulse('perf'));
		deleteAttribute(db, actor, realm.id, 'perf', NOW);
		define({ key: 'perf', kind: 'scale', spec: { min: 0, max: 4 } });
		const filed = postOne(pulse('perf'));
		const other = postOne(pulse('x'));

		const moved = filePulses(db, actor, realm.id, 'perf', 'bugs:crash');

		expect(moved).toBe(2);
		expect(rowOf(unfiled).member).toBe('crash');
		expect(rowOf(filed).member).toBe('crash');
		expect(rowOf(other).attributeId).toBeNull();
	});

	it('does not move a filed Pulse because its rawKey column matches', () => {
		const id = postOne(pulse('perf'));
		filePulses(db, actor, realm.id, 'perf', 'bugs:lag');

		const moved = filePulses(db, actor, realm.id, 'perf', 'bugs:crash');

		expect(moved).toBe(0);
		expect(rowOf(id).member).toBe('lag');
	});

	it('leaves the Pulses of other Realms alone', () => {
		const other = seedRealm(db, 'BL');
		const [theirs] = postPulses(db, actor, other.id, [pulse('slow')], NOW);
		postOne(pulse('slow'));

		const moved = filePulses(db, actor, realm.id, 'slow', 'perf');

		expect(moved).toBe(1);
		expect(rowOf(theirs.id).attributeId).toBeNull();
	});

	it('returns 0 when nothing matches', () => {
		expect(filePulses(db, actor, realm.id, 'nothing', 'perf')).toBe(0);
	});

	it('keeps amount, mood, note and time of the Pulses it moves', () => {
		const id = postOne(pulse('slow', { amount: 2, mood: -0.5, note: 'n' }), ago(3));

		filePulses(db, actor, realm.id, 'slow', 'perf');

		expect(rowOf(id)).toMatchObject({
			amount: 2,
			mood: -0.5,
			note: 'n',
			createdAt: ago(3),
			authorId: actor.id
		});
	});

	it.each([
		['an unknown Attribute', 'ghost'],
		['a bare tags key', 'bugs'],
		['a bare text key', 'notes'],
		['a member of a scale', 'perf:high'],
		['an unknown member', 'bugs:nope'],
		['a malformed key', 'Bad Key']
	])('refuses %s as the key and moves nothing', (_name, key) => {
		const id = postOne(pulse('slow'));

		expectDomainError(() => filePulses(db, actor, realm.id, 'slow', key), 'invalid');
		expect(rowOf(id).attributeId).toBeNull();
	});
});

describe('deletePulse', () => {
	it('removes the Pulse from the Sentiment', () => {
		const filed = postOne(pulse('perf'));
		const unfiled = postOne(pulse('ghost'));

		deletePulse(db, actor, filed);
		deletePulse(db, actor, unfiled);

		expect(rows()).toEqual([]);
		expect(read()).toMatchObject({ keys: [], unfiled: [] });
	});

	it('removes only the named Pulse', () => {
		const gone = postOne(pulse('perf'));
		const stays = postOne(pulse('perf'));

		deletePulse(db, actor, gone);

		expect(read().keys[0].pulses.map((p) => p.id)).toEqual([stays]);
	});

	it('lets any User delete a Pulse another User wrote', () => {
		const id = postOne(pulse('perf'));
		const bob = { id: seedUser(db, 'bob') };

		deletePulse(db, bob, id);

		expect(rows()).toEqual([]);
	});

	it('refuses an unknown id', () => {
		expectDomainError(() => deletePulse(db, actor, 9999), 'not_found');
	});
});

describe('Attribute changes', () => {
	it('unfiles the Pulses of a deleted Attribute, keeping their rawKey', () => {
		const direct = postOne(pulse('perf', { amount: 2, halfLifeDays: null }));
		const refiled = postOne(pulse('slow', { amount: 3, halfLifeDays: null }));
		filePulses(db, actor, realm.id, 'slow', 'perf');
		const member = postOne(pulse('bugs:lag', { halfLifeDays: null }));

		deleteAttribute(db, actor, realm.id, 'perf', NOW);

		const view = read();
		expect(keysOf(view)).toEqual(['bugs:lag']);
		expect(view.unfiled).toEqual([
			{ rawKey: 'slow', volume: 3, count: 1, newest: { id: refiled, note: '' } },
			{ rawKey: 'perf', volume: 2, count: 1, newest: { id: direct, note: '' } }
		]);
		expect(rowOf(direct)).toMatchObject({ rawKey: 'perf', attributeId: null });
		expect(rowOf(refiled)).toMatchObject({ rawKey: 'slow', attributeId: null });
		expect(rowOf(member).attributeId).toBe(bugsId);
	});

	it('leaves the Pulses of the same Attribute key in another Realm filed', () => {
		const other = seedRealm(db, 'BL');
		defineAttribute(
			db,
			actor,
			other.id,
			{ key: 'perf', kind: 'scale', label: 'Perf', rubric: 'r', spec: { min: 0, max: 4 } },
			NOW
		);
		const [theirs] = postPulses(db, actor, other.id, [pulse('perf')], NOW);

		deleteAttribute(db, actor, realm.id, 'perf', NOW);

		expect(rowOf(theirs.id).attributeId).not.toBeNull();
	});

	it('does not refile Pulses when the Attribute is defined again', () => {
		const id = postOne(pulse('perf'));
		deleteAttribute(db, actor, realm.id, 'perf', NOW);

		define({ key: 'perf', kind: 'scale', spec: { min: 0, max: 4 } });

		expect(read().keys).toEqual([]);
		expect(rowOf(id).attributeId).toBeNull();
		expect(read().unfiled.map((entry) => entry.rawKey)).toEqual(['perf']);
	});

	it('files the Pulses again on request after the Attribute is defined again', () => {
		const id = postOne(pulse('perf'));
		deleteAttribute(db, actor, realm.id, 'perf', NOW);
		const again = define({ key: 'perf', kind: 'scale', spec: { min: 0, max: 4 } });

		const moved = filePulses(db, actor, realm.id, 'perf', 'perf');

		expect(moved).toBe(1);
		expect(rowOf(id).attributeId).toBe(again);
		expect(keysOf(read())).toEqual(['perf']);
	});

	it('unfiles the Pulses of members removed from a tags Attribute', () => {
		const lag = postOne(pulse('bugs:lag'));
		const laggy = postOne(pulse('laggy'));
		filePulses(db, actor, realm.id, 'laggy', 'bugs:lag');
		const crash = postOne(pulse('bugs:crash'));
		const hang = postOne(pulse('bugs:hang'));

		defineAttribute(
			db,
			actor,
			realm.id,
			{ key: 'bugs', kind: 'tags', spec: { members: [{ key: 'crash', label: 'Crash' }] } },
			NOW
		);

		const view = read();
		expect(keysOf(view)).toEqual(['bugs:crash']);
		expect(view.unfiled.map((entry) => entry.rawKey).sort()).toEqual([
			'bugs:hang',
			'bugs:lag',
			'laggy'
		]);
		expect(rowOf(lag)).toMatchObject({ rawKey: 'bugs:lag', attributeId: null });
		expect(rowOf(laggy)).toMatchObject({ rawKey: 'laggy', attributeId: null });
		expect(rowOf(hang).attributeId).toBeNull();
		expect(rowOf(crash).attributeId).toBe(bugsId);
	});

	it('does not refile the Pulses of a member added back', () => {
		const lag = postOne(pulse('bugs:lag'));
		defineAttribute(
			db,
			actor,
			realm.id,
			{ key: 'bugs', kind: 'tags', spec: { members: [{ key: 'crash', label: 'Crash' }] } },
			NOW
		);

		defineAttribute(
			db,
			actor,
			realm.id,
			{
				key: 'bugs',
				kind: 'tags',
				spec: {
					members: [
						{ key: 'crash', label: 'Crash' },
						{ key: 'lag', label: 'Lag' }
					]
				}
			},
			NOW
		);

		expect(rowOf(lag).attributeId).toBeNull();
		expect(read().keys).toEqual([]);
	});

	it('keeps Pulses filed when an Attribute is revised without losing a member', () => {
		const lag = postOne(pulse('bugs:lag'));
		const perf = postOne(pulse('perf'));

		defineAttribute(db, actor, realm.id, { key: 'bugs', kind: 'tags', rubric: 'Revised' }, NOW);
		defineAttribute(
			db,
			actor,
			realm.id,
			{ key: 'perf', kind: 'scale', spec: { min: 0, max: 2 } },
			NOW
		);

		expect(rowOf(lag).attributeId).toBe(bugsId);
		expect(rowOf(perf).attributeId).toBe(perfId);
	});
});

describe('prunePulses', () => {
	const T_DAYS = (halfLifeDays: number) => halfLifeDays * Math.log2(100);

	it('deletes a Pulse older than halfLife × log2(100) days and keeps one exactly at it', () => {
		const limit = T_DAYS(7) * DAY;
		const now = NOW.getTime();
		const within = postOne(pulse('perf', { halfLifeDays: 7 }), new Date(now - Math.floor(limit)));
		const beyond = postOne(pulse('perf', { halfLifeDays: 7 }), new Date(now - Math.ceil(limit)));

		const deleted = prunePulses(db, now);

		expect(deleted).toBe(1);
		expect(rows().map((row) => row.id)).toEqual([within]);
		expect(rows().map((row) => row.id)).not.toContain(beyond);
	});

	it('measures each Pulse against its own half-life', () => {
		const short = postOne(pulse('perf', { halfLifeDays: 1 }), ago(10));
		const long = postOne(pulse('perf', { halfLifeDays: 14 }), ago(10));
		const unfiled = postOne(pulse('ghost', { halfLifeDays: 1 }), ago(10));

		const deleted = prunePulses(db, NOW.getTime());

		expect(deleted).toBe(2);
		expect(rows().map((row) => row.id)).toEqual([long]);
		expect(rows().map((row) => row.id)).not.toContain(short);
		expect(rows().map((row) => row.id)).not.toContain(unfiled);
	});

	it('keeps a Pulse without a half-life however old', () => {
		const id = postOne(pulse('perf', { halfLifeDays: null }), ago(100_000));

		const deleted = prunePulses(db, NOW.getTime());

		expect(deleted).toBe(0);
		expect(rows().map((row) => row.id)).toEqual([id]);
	});

	it('prunes against the now it is given', () => {
		postOne(pulse('perf', { halfLifeDays: 1 }));

		expect(prunePulses(db, NOW.getTime() + 6 * DAY)).toBe(0);
		expect(prunePulses(db, NOW.getTime() + 7 * DAY)).toBe(1);
	});

	it('defaults now to the current time', () => {
		postOne(pulse('perf', { halfLifeDays: 1 }), new Date(Date.now() - 30 * DAY));
		const fresh = postOne(pulse('perf', { halfLifeDays: 1 }), new Date());

		const deleted = prunePulses(db);

		expect(deleted).toBe(1);
		expect(rows().map((row) => row.id)).toEqual([fresh]);
	});

	it('returns 0 with nothing to prune', () => {
		expect(prunePulses(db, NOW.getTime())).toBe(0);
	});
});

describe('Pulses stay off the board', () => {
	const writes: [string, () => void][] = [
		['postPulses', () => post([pulse('perf'), pulse('ghost')])],
		['filePulses', () => filePulses(db, actor, realm.id, 'ghost', 'perf')],
		['deletePulse', () => deletePulse(db, actor, rows()[0].id)],
		['prunePulses', () => prunePulses(db, NOW.getTime())]
	];

	it.each(writes)('%s records no Event and changes no Labour or Realm version', (_name, write) => {
		seedLabour(db, { realmId: realm.id });
		post([pulse('ghost', { halfLifeDays: 1 })], ago(30));
		const before = {
			events: db.select().from(events).all(),
			labours: db.select().from(labours).all(),
			realmAgent: db.select().from(realmAgent).all(),
			version: readRealmAgent(db, realm.id).version
		};

		write();

		expect(db.select().from(events).all()).toEqual(before.events);
		expect(db.select().from(labours).all()).toEqual(before.labours);
		expect(db.select().from(realmAgent).all()).toEqual(before.realmAgent);
		expect(readRealmAgent(db, realm.id).version).toBe(before.version);
	});
});
