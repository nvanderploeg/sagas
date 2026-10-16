import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { pulses, realmAgent } from '#lib/server/db/schema.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { defineAttribute, deleteAttribute, setValues } from './attributes.ts';
import { scheduleAgentPruning } from './prune.ts';
import { filePulses, postPulses, prunePulses, readSentiment } from './sentiment.ts';
import { survey } from './survey/index.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

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

const impact = () =>
	defineAttribute(db, actor, realmId, {
		key: 'impact',
		kind: 'scale',
		label: 'Impact',
		rubric: 'x',
		spec: { min: 0, max: 4 }
	}).attribute;

const topic = (members = ['boss', 'ui']) =>
	defineAttribute(db, actor, realmId, {
		key: 'topic',
		kind: 'tags',
		label: 'Topic',
		rubric: 'x',
		spec: { members: members.map((key) => ({ key, label: key })) }
	}).attribute;

const pulse = (key: string, extra: Record<string, unknown> = {}) =>
	postPulses(db, actor, realmId, [{ key, amount: 2, mood: 0.5, ...extra }], NOW)[0];

const rows = () => db.select().from(pulses).all();

// An Affinity Pulse names an Attribute of a Realm and belongs to a User.
function affinity(attributeId: number, member: string | null) {
	return db
		.insert(pulses)
		.values({
			userId: actor.id,
			attributeId,
			member,
			rawKey: member === null ? 'impact' : `topic:${member}`,
			amount: 1,
			mood: 0,
			authorId: actor.id,
			createdAt: NOW
		})
		.returning({ id: pulses.id })
		.get().id;
}

describe('the pulses table', () => {
	const base = {
		realmId: 0,
		rawKey: 'impact',
		amount: 1,
		mood: 0,
		authorId: 0,
		createdAt: NOW
	};

	const insert = (values: Partial<typeof pulses.$inferInsert>) =>
		db
			.insert(pulses)
			.values({ ...base, realmId, authorId: actor.id, ...values })
			.run();

	it('needs exactly one of realm_id and user_id', () => {
		expect(() => insert({ realmId: undefined, userId: undefined })).toThrow(/pulses_one_owner/);
		expect(() => insert({ userId: actor.id })).toThrow(/pulses_one_owner/);
		expect(() => insert({})).not.toThrow();
	});

	it('keeps only a Sentiment Pulse unfiled', () => {
		const { id } = impact();
		expect(() => insert({ realmId: undefined, userId: actor.id })).toThrow(
			/pulses_unfiled_is_sentiment/
		);
		expect(() => insert({ member: 'x' })).toThrow(/pulses_unfiled_is_sentiment/);
		expect(() => insert({ realmId: undefined, userId: actor.id, attributeId: id })).not.toThrow();
	});

	it('bounds amount, mood and half-life, and requires valid evidence JSON', () => {
		expect(() => insert({ amount: 0 })).toThrow(/pulses_amount/);
		expect(() => insert({ amount: 10.5 })).toThrow(/pulses_amount/);
		expect(() => insert({ mood: 1.1 })).toThrow(/pulses_mood/);
		expect(() => insert({ mood: -1.1 })).toThrow(/pulses_mood/);
		expect(() => insert({ halfLifeDays: 0 })).toThrow(/pulses_half_life/);
		expect(() => insert({ halfLifeDays: 366 })).toThrow(/pulses_half_life/);
		expect(() =>
			db.$client
				.prepare(
					`INSERT INTO pulses (realm_id, raw_key, amount, mood, evidence, author_id, created_at)
					 VALUES (?, 'impact', 1, 0, 'not json', ?, 0)`
				)
				.run(realmId, actor.id)
		).toThrow(/pulses_evidence_json/);
		expect(() => insert({ amount: 10, mood: -1, halfLifeDays: 365 })).not.toThrow();
	});

	it('refuses one author reusing a ref under a raw key, but not a null ref', () => {
		const other = seedUser(db, 'other');
		insert({ ref: 'm1' });
		expect(() => insert({ ref: 'm1' })).toThrow(/UNIQUE/);
		expect(() => insert({ ref: 'm1', rawKey: 'other' })).not.toThrow();
		expect(() => insert({ ref: 'm1', authorId: other })).not.toThrow();
		expect(() => insert({})).not.toThrow();
		expect(() => insert({})).not.toThrow();
	});

	it('defaults the note and the evidence', () => {
		insert({});
		expect(rows()[0]).toMatchObject({ note: '', evidence: [] });
	});
});

describe('unfiling', () => {
	it('unfiles a deleted Attribute, keeps its raw key and deletes its Affinity Pulses', () => {
		const { id } = impact();
		pulse('impact');
		const kept = affinity(id, null);

		deleteAttribute(db, actor, realmId, 'impact');

		expect(rows().map((row) => row.id)).toHaveLength(1);
		expect(rows().find((row) => row.id === kept)).toBeUndefined();
		expect(rows()[0]).toMatchObject({ attributeId: null, member: null, rawKey: 'impact' });
	});

	it('unfiles the Sentiment Pulses of removed members and deletes their Affinity Pulses', () => {
		const { id } = topic();
		const boss = pulse('topic:boss');
		const ui = pulse('topic:ui');
		const mine = affinity(id, 'boss');
		const kept = affinity(id, 'ui');

		defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			spec: { members: [{ key: 'ui', label: 'ui' }] }
		});

		const byId = new Map(rows().map((row) => [row.id, row]));
		expect(byId.get(boss.id)).toMatchObject({
			attributeId: null,
			member: null,
			rawKey: 'topic:boss'
		});
		expect(byId.get(ui.id)).toMatchObject({ attributeId: id, member: 'ui' });
		expect(byId.has(mine)).toBe(false);
		expect(byId.get(kept)).toMatchObject({ userId: actor.id, attributeId: id, member: 'ui' });
	});

	it('leaves Pulses filed when a revision keeps every member', () => {
		const { id } = topic();
		const boss = pulse('topic:boss');

		defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			spec: {
				members: [
					{ key: 'boss', label: 'Boss' },
					{ key: 'ui', label: 'UI' },
					{ key: 'new', label: 'New' }
				]
			}
		});

		expect(rows().find((row) => row.id === boss.id)).toMatchObject({ attributeId: id });
	});

	it('does not refile on a later define, but file_pulses can', () => {
		impact();
		pulse('impact');
		deleteAttribute(db, actor, realmId, 'impact');
		const again = impact();

		expect(rows()[0].attributeId).toBeNull();
		expect(filePulses(db, actor, realmId, 'impact', 'impact')).toBe(1);
		expect(rows()[0].attributeId).toBe(again.id);
	});

	it('writes no version bump for a Pulse', () => {
		impact();
		const before = db.select().from(realmAgent).all();
		pulse('impact');
		pulse('nothing-here');
		expect(db.select().from(realmAgent).all()).toEqual(before);
	});
});

describe('prunePulses', () => {
	const fadedAfter = (halfLifeDays: number) => halfLifeDays * Math.log2(100);

	it('deletes Pulses past half-life times log2(100) days and keeps ones that never fade', () => {
		impact();
		const post = (halfLifeDays: number | null, days: number) =>
			postPulses(
				db,
				actor,
				realmId,
				[{ key: 'impact', amount: 1, mood: 0, halfLifeDays }],
				ago(days)
			)[0].id;
		post(10, fadedAfter(10) + 0.01);
		const young = post(10, fadedAfter(10) - 0.01);
		const never = post(null, 5000);

		expect(prunePulses(db, NOW.getTime())).toBe(1);
		expect(
			rows()
				.map((row) => row.id)
				.sort()
		).toEqual([young, never].sort());
	});

	it('runs with scheduleAgentPruning, at startup and on the interval', () => {
		vi.useFakeTimers();
		try {
			impact();
			postPulses(
				db,
				actor,
				realmId,
				[{ key: 'impact', amount: 1, mood: 0, halfLifeDays: 1 }],
				ago(100)
			);
			const stop = scheduleAgentPruning(db, 30 * DAY, 1000);
			expect(rows()).toHaveLength(0);

			postPulses(
				db,
				actor,
				realmId,
				[{ key: 'impact', amount: 1, mood: 0, halfLifeDays: 1 }],
				ago(100)
			);
			expect(rows()).toHaveLength(1);
			vi.advanceTimersByTime(1000);
			expect(rows()).toHaveLength(0);
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('reading', () => {
	it('decays at the stated half-life and sums by key', () => {
		impact();
		postPulses(
			db,
			actor,
			realmId,
			[{ key: 'impact', amount: 4, mood: 1, halfLifeDays: 10 }],
			ago(10)
		);
		postPulses(
			db,
			actor,
			realmId,
			[{ key: 'impact', amount: 2, mood: -1, halfLifeDays: null }],
			ago(500)
		);

		const [key] = readSentiment(db, realmId, { now: NOW }).keys;

		expect(key.volume).toBeCloseTo(4, 10);
		expect(key.mood).toBeCloseTo(0, 10);
		expect(key.v).toBeCloseTo(4 / 9, 10);
	});

	it('lists unfiled keys with their newest Pulse', () => {
		pulse('nothing', { note: 'first' });
		postPulses(
			db,
			actor,
			realmId,
			[{ key: 'nothing', amount: 1, mood: 0, note: 'second' }],
			ago(-1)
		);

		const { unfiled, keys } = readSentiment(db, realmId, { now: ago(-1) });

		expect(keys).toEqual([]);
		expect(unfiled).toEqual([
			{ rawKey: 'nothing', volume: expect.any(Number), count: 2, newest: { id: 2, note: 'second' } }
		]);
	});

	it('moves unfiled and already filed Pulses with file_pulses, leaving raw keys', () => {
		impact();
		topic();
		pulse('boss');
		pulse('boss');
		pulse('impact');

		expect(filePulses(db, actor, realmId, 'boss', 'topic:boss')).toBe(2);
		expect(filePulses(db, actor, realmId, 'topic:boss', 'topic:ui')).toBe(2);
		expect(filePulses(db, actor, realmId, 'topic:ui', 'topic:ui')).toBe(0);
		expect(rows().map((row) => row.rawKey)).toEqual(['boss', 'boss', 'impact']);
		expect(
			readSentiment(db, realmId, { now: NOW })
				.keys.map((key) => key.key)
				.sort()
		).toEqual(['impact', 'topic:ui']);
	});

	it('skips a repeated ref within one batch and across calls', () => {
		impact();
		const first = postPulses(
			db,
			actor,
			realmId,
			[
				{ key: 'impact', amount: 1, mood: 0, ref: 'a' },
				{ key: 'impact', amount: 1, mood: 0, ref: 'a' },
				{ key: 'IMPACT ', amount: 1, mood: 0, ref: ' a ' }
			],
			NOW
		);
		expect(first.map((r) => r.status)).toEqual(['filed', 'skipped', 'skipped']);
		expect(first[1].id).toBe(first[0].id);
		expect(rows()).toHaveLength(1);
	});
});

describe('batched reads', () => {
	const statements = (run: () => void): number => {
		const spy = vi.spyOn(db.$client, 'prepare');
		run();
		const calls = spy.mock.calls.length;
		spy.mockRestore();
		return calls;
	};

	it('checks evidence Labours in one query however many Pulses name them', () => {
		impact();
		const named = Array.from({ length: 12 }, () => seedLabour(db, { realmId }));
		const post = (n: number) =>
			postPulses(
				db,
				actor,
				realmId,
				Array.from({ length: n }, () => ({
					key: 'impact',
					amount: 1,
					mood: 0,
					evidence: named.slice(0, 10).map((labour) => ({ labour: labour.id }))
				})),
				NOW
			);
		post(1);
		const few = statements(() => readSentiment(db, realmId, { now: NOW, limit: 20 }));
		post(10);
		expect(statements(() => readSentiment(db, realmId, { now: NOW, limit: 20 }))).toBe(few);
	});

	it('leaves out evidence naming a deleted Labour', () => {
		impact();
		const [gone, kept] = [seedLabour(db, { realmId }), seedLabour(db, { realmId })];
		pulse('impact', {
			evidence: [{ labour: gone.id }, { href: 'https://x.test', label: ' ' }, { labour: kept.id }]
		});
		deleteLabour(db, actor, gone.id);

		const [key] = readSentiment(db, realmId, { now: NOW }).keys;

		expect(key.pulses[0].evidence).toEqual([
			{ href: 'https://x.test', label: null },
			{ labour: kept.id }
		]);
	});

	it('scores the Sentiment features with the same statements however many Labours it scores', () => {
		impact();
		pulse('impact');
		const make = (n: number) => {
			for (let i = 0; i < n; i += 1) {
				const labour = seedLabour(db, { realmId });
				setValues(db, actor, labour.id, { impact: i % 5 }, NOW);
			}
		};
		const run = () =>
			survey(
				db,
				actor,
				{ weights: { sentiment: 1, pain: 1, delight: 1 }, temperature: 0 },
				{ now: NOW }
			);
		make(3);
		const few = statements(run);
		make(30);
		expect(statements(run)).toBe(few);
	});

	it('shows the notes behind the keys of the returned Labours only', () => {
		impact();
		topic();
		pulse('impact', { note: 'loud' });
		pulse('topic:ui', { note: 'quiet' });
		const labour = seedLabour(db, { realmId });
		setValues(db, actor, labour.id, { impact: 4 }, NOW);

		const result = survey(db, actor, { weights: { sentiment: 1 }, temperature: 0 }, { now: NOW });

		expect(result.sentiment).toHaveLength(1);
		expect(result.sentiment[0]).toMatchObject({ realmId, key: 'impact' });
		expect(result.sentiment[0].pulses.map((p) => p.note)).toEqual(['loud']);
		expect(survey(db, actor, { weights: { age: 1 } }, { now: NOW }).sentiment).toEqual([]);
	});
});
