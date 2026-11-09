import { asc } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { pulses, realmAgent } from '#lib/server/db/schema.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb, countStatements, expectFailure } from '#lib/server/test/db.ts';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
});

const impact = async () =>
	(
		await defineAttribute(db, actor, realmId, {
			key: 'impact',
			kind: 'scale',
			label: 'Impact',
			rubric: 'x',
			spec: { min: 0, max: 4 }
		})
	).attribute;

const topic = async (members = ['boss', 'ui']) =>
	(
		await defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			label: 'Topic',
			rubric: 'x',
			spec: { members: members.map((key) => ({ key, label: key })) }
		})
	).attribute;

const pulse = async (key: string, extra: Record<string, unknown> = {}) =>
	(await postPulses(db, actor, realmId, [{ key, amount: 2, mood: 0.5, ...extra }], NOW))[0];

const rows = async () => await db.select().from(pulses).orderBy(asc(pulses.id));

// An Affinity Pulse names an Attribute of a Realm and belongs to a User.
async function affinity(attributeId: number, member: string | null) {
	return (
		await db
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
	)[0].id;
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
		db.insert(pulses).values({ ...base, realmId, authorId: actor.id, ...values });

	it('needs exactly one of realm_id and user_id', async () => {
		await expectFailure(insert({ realmId: undefined, userId: undefined }), /pulses_one_owner/);
		await expectFailure(insert({ userId: actor.id }), /pulses_one_owner/);
		expect(() => insert({})).not.toThrow();
	});

	it('keeps only a Sentiment Pulse unfiled', async () => {
		const { id } = await impact();
		await expectFailure(
			insert({ realmId: undefined, userId: actor.id }),
			/pulses_unfiled_is_sentiment/
		);
		await expectFailure(insert({ member: 'x' }), /pulses_unfiled_is_sentiment/);
		expect(() => insert({ realmId: undefined, userId: actor.id, attributeId: id })).not.toThrow();
	});

	it('bounds amount, mood and half-life, and requires valid evidence JSON', async () => {
		await expectFailure(insert({ amount: 0 }), /pulses_amount/);
		await expectFailure(insert({ amount: 10.5 }), /pulses_amount/);
		await expectFailure(insert({ mood: 1.1 }), /pulses_mood/);
		await expectFailure(insert({ mood: -1.1 }), /pulses_mood/);
		await expectFailure(insert({ halfLifeDays: 0 }), /pulses_half_life/);
		await expectFailure(insert({ halfLifeDays: 366 }), /pulses_half_life/);
		await expect(
			db.$client.query(
				`INSERT INTO sagas_pulses (realm_id, raw_key, amount, mood, evidence, author_id, created_at)
				 VALUES ($1, 'impact', 1, 0, 'not json', $2, 0)`,
				[realmId, actor.id]
			)
		).rejects.toThrow(/invalid input syntax for type json/);
		expect(() => insert({ amount: 10, mood: -1, halfLifeDays: 365 })).not.toThrow();
	});

	it('refuses one author reusing a ref under a raw key, but not a null ref', async () => {
		const other = await seedUser(db, 'other');
		await insert({ ref: 'm1' });
		await expectFailure(insert({ ref: 'm1' }), /pulses_author_ref_key_uq/);
		expect(() => insert({ ref: 'm1', rawKey: 'other' })).not.toThrow();
		expect(() => insert({ ref: 'm1', authorId: other })).not.toThrow();
		expect(() => insert({})).not.toThrow();
		expect(() => insert({})).not.toThrow();
	});

	it('defaults the note and the evidence', async () => {
		await insert({});
		expect((await rows())[0]).toMatchObject({ note: '', evidence: [] });
	});
});

describe('unfiling', () => {
	it('unfiles a deleted Attribute, keeps its raw key and deletes its Affinity Pulses', async () => {
		const { id } = await impact();
		await pulse('impact');
		const kept = await affinity(id, null);

		await deleteAttribute(db, actor, realmId, 'impact');

		expect((await rows()).map((row) => row.id)).toHaveLength(1);
		expect((await rows()).find((row) => row.id === kept)).toBeUndefined();
		expect((await rows())[0]).toMatchObject({ attributeId: null, member: null, rawKey: 'impact' });
	});

	it('unfiles the Sentiment Pulses of removed members and deletes their Affinity Pulses', async () => {
		const { id } = await topic();
		const boss = await pulse('topic:boss');
		const ui = await pulse('topic:ui');
		const mine = await affinity(id, 'boss');
		const kept = await affinity(id, 'ui');

		await defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			spec: { members: [{ key: 'ui', label: 'ui' }] }
		});

		const byId = new Map((await rows()).map((row) => [row.id, row]));
		expect(byId.get(boss.id)).toMatchObject({
			attributeId: null,
			member: null,
			rawKey: 'topic:boss'
		});
		expect(byId.get(ui.id)).toMatchObject({ attributeId: id, member: 'ui' });
		expect(byId.has(mine)).toBe(false);
		expect(byId.get(kept)).toMatchObject({ userId: actor.id, attributeId: id, member: 'ui' });
	});

	it('leaves Pulses filed when a revision keeps every member', async () => {
		const { id } = await topic();
		const boss = await pulse('topic:boss');

		await defineAttribute(db, actor, realmId, {
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

		expect((await rows()).find((row) => row.id === boss.id)).toMatchObject({ attributeId: id });
	});

	it('does not refile on a later define, but file_pulses can', async () => {
		await impact();
		await pulse('impact');
		await deleteAttribute(db, actor, realmId, 'impact');
		const again = await impact();

		expect((await rows())[0].attributeId).toBeNull();
		expect(await filePulses(db, actor, realmId, 'impact', 'impact')).toBe(1);
		expect((await rows())[0].attributeId).toBe(again.id);
	});

	it('writes no version bump for a Pulse', async () => {
		await impact();
		const before = await db.select().from(realmAgent);
		await pulse('impact');
		await pulse('nothing-here');
		expect(await db.select().from(realmAgent)).toEqual(before);
	});
});

describe('prunePulses', () => {
	const fadedAfter = (halfLifeDays: number) => halfLifeDays * Math.log2(100);

	it('deletes Pulses past half-life times log2(100) days and keeps ones that never fade', async () => {
		await impact();
		const post = async (halfLifeDays: number | null, days: number) =>
			(
				await postPulses(
					db,
					actor,
					realmId,
					[{ key: 'impact', amount: 1, mood: 0, halfLifeDays }],
					ago(days)
				)
			)[0].id;
		await post(10, fadedAfter(10) + 0.01);
		const young = await post(10, fadedAfter(10) - 0.01);
		const never = await post(null, 5000);

		expect(await prunePulses(db, NOW.getTime())).toBe(1);
		expect((await rows()).map((row) => row.id).sort()).toEqual([young, never].sort());
	});

	it('runs with scheduleAgentPruning, at startup and on the interval', async () => {
		vi.useFakeTimers();
		try {
			await impact();
			await postPulses(
				db,
				actor,
				realmId,
				[{ key: 'impact', amount: 1, mood: 0, halfLifeDays: 1 }],
				ago(100)
			);
			const stop = await scheduleAgentPruning(db, 30 * DAY, 1000);
			expect(await rows()).toHaveLength(0);

			await postPulses(
				db,
				actor,
				realmId,
				[{ key: 'impact', amount: 1, mood: 0, halfLifeDays: 1 }],
				ago(100)
			);
			expect(await rows()).toHaveLength(1);
			vi.advanceTimersByTime(1000);
			expect(await rows()).toHaveLength(0);
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('reading', () => {
	it('decays at the stated half-life and sums by key', async () => {
		await impact();
		await postPulses(
			db,
			actor,
			realmId,
			[{ key: 'impact', amount: 4, mood: 1, halfLifeDays: 10 }],
			ago(10)
		);
		await postPulses(
			db,
			actor,
			realmId,
			[{ key: 'impact', amount: 2, mood: -1, halfLifeDays: null }],
			ago(500)
		);

		const [key] = (await readSentiment(db, realmId, { now: NOW })).keys;

		expect(key.volume).toBeCloseTo(4, 10);
		expect(key.mood).toBeCloseTo(0, 10);
		expect(key.v).toBeCloseTo(4 / 9, 10);
	});

	it('lists unfiled keys with their newest Pulse', async () => {
		await pulse('nothing', { note: 'first' });
		await postPulses(
			db,
			actor,
			realmId,
			[{ key: 'nothing', amount: 1, mood: 0, note: 'second' }],
			ago(-1)
		);

		const { unfiled, keys } = await readSentiment(db, realmId, { now: ago(-1) });

		expect(keys).toEqual([]);
		expect(unfiled).toEqual([
			{ rawKey: 'nothing', volume: expect.any(Number), count: 2, newest: { id: 2, note: 'second' } }
		]);
	});

	it('moves unfiled and already filed Pulses with file_pulses, leaving raw keys', async () => {
		await impact();
		await topic();
		await pulse('boss');
		await pulse('boss');
		await pulse('impact');

		expect(await filePulses(db, actor, realmId, 'boss', 'topic:boss')).toBe(2);
		expect(await filePulses(db, actor, realmId, 'topic:boss', 'topic:ui')).toBe(2);
		expect(await filePulses(db, actor, realmId, 'topic:ui', 'topic:ui')).toBe(0);
		expect((await rows()).map((row) => row.rawKey)).toEqual(['boss', 'boss', 'impact']);
		expect(
			(await readSentiment(db, realmId, { now: NOW })).keys.map((key) => key.key).sort()
		).toEqual(['impact', 'topic:ui']);
	});

	it('skips a repeated ref within one batch and across calls', async () => {
		await impact();
		const first = await postPulses(
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
		expect(await rows()).toHaveLength(1);
	});
});

describe('batched reads', () => {
	function statements(run: () => unknown): Promise<number> {
		return countStatements(run);
	}

	it('checks evidence Labours in one query however many Pulses name them', async () => {
		await impact();
		const named = await Promise.all(Array.from({ length: 12 }, () => seedLabour(db, { realmId })));
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
		await post(1);
		const few = await statements(() => readSentiment(db, realmId, { now: NOW, limit: 20 }));
		await post(10);
		expect(await statements(() => readSentiment(db, realmId, { now: NOW, limit: 20 }))).toBe(few);
	});

	it('leaves out evidence naming a deleted Labour', async () => {
		await impact();
		const [gone, kept] = [await seedLabour(db, { realmId }), await seedLabour(db, { realmId })];
		await pulse('impact', {
			evidence: [{ labour: gone.id }, { href: 'https://x.test', label: ' ' }, { labour: kept.id }]
		});
		await deleteLabour(db, actor, gone.id);

		const [key] = (await readSentiment(db, realmId, { now: NOW })).keys;

		expect(key.pulses[0].evidence).toEqual([
			{ href: 'https://x.test', label: null },
			{ labour: kept.id }
		]);
	});

	it('scores the Sentiment features with the same statements however many Labours it scores', async () => {
		await impact();
		await pulse('impact');
		const make = async (n: number) => {
			for (let i = 0; i < n; i += 1) {
				const labour = await seedLabour(db, { realmId });
				await setValues(db, actor, labour.id, { impact: i % 5 }, NOW);
			}
		};
		const run = () =>
			survey(
				db,
				actor,
				{ weights: { sentiment: 1, pain: 1, delight: 1 }, temperature: 0 },
				{ now: NOW }
			);
		await make(3);
		const few = await statements(run);
		await make(30);
		expect(await statements(run)).toBe(few);
	});

	it('shows the notes behind the keys of the returned Labours only', async () => {
		await impact();
		await topic();
		await pulse('impact', { note: 'loud' });
		await pulse('topic:ui', { note: 'quiet' });
		const labour = await seedLabour(db, { realmId });
		await setValues(db, actor, labour.id, { impact: 4 }, NOW);

		const result = await survey(
			db,
			actor,
			{ weights: { sentiment: 1 }, temperature: 0 },
			{ now: NOW }
		);

		expect(result.sentiment).toHaveLength(1);
		expect(result.sentiment[0]).toMatchObject({ realmId, key: 'impact' });
		expect(result.sentiment[0].pulses.map((p) => p.note)).toEqual(['loud']);
		expect((await survey(db, actor, { weights: { age: 1 } }, { now: NOW })).sentiment).toEqual([]);
	});
});
