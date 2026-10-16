import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { outcomes, pulses, surveys } from '#lib/server/db/schema.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { defineAttribute, setValues } from './attributes.ts';
import { reportOutcomes } from './outcomes.ts';
import { readAffinity } from './sentiment.ts';
import { pruneSurveys, survey } from './survey/index.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realmId = seedRealm(db, 'AM').id;
	defineAttribute(db, actor, realmId, {
		key: 'impact',
		kind: 'scale',
		label: 'Impact',
		rubric: 'x',
		spec: { min: 0, max: 4 }
	});
	defineAttribute(db, actor, realmId, {
		key: 'topic',
		kind: 'tags',
		label: 'Topic',
		rubric: 'x',
		spec: {
			members: [
				{ key: 'boss', label: 'Boss' },
				{ key: 'ui', label: 'UI' }
			]
		}
	});
});

afterEach(() => {
	db.$client.close();
});

const labour = (values: Record<string, unknown> = { impact: 2, topic: ['boss'] }) => {
	const made = seedLabour(db, { realmId });
	setValues(db, actor, made.id, values);
	return made;
};

const ask = (limit = 15, forId = actor.id) =>
	survey(db, actor, { weights: { age: 1 }, temperature: 0, limit, forUserId: forId }, { now: NOW });

const stored = () => db.select().from(outcomes).all();

describe('the outcomes table', () => {
	const row = (over: Partial<typeof outcomes.$inferInsert> = {}) => {
		const { surveyId, results } = ask();
		return {
			surveyId,
			labourId: results[0]?.labourId ?? 0,
			verdict: 'picked' as const,
			authorId: actor.id,
			createdAt: NOW,
			...over
		};
	};

	it('refuses an unknown verdict', () => {
		labour();
		const insert = (verdict: string) =>
			db.$client
				.prepare(
					`INSERT INTO outcomes (survey_id, labour_id, verdict, author_id, created_at)
					 VALUES (?, ?, ?, ?, 0)`
				)
				.run(row().surveyId, row().labourId, verdict, actor.id);
		expect(() => insert('abandoned')).toThrow(/outcomes_verdict/);
		expect(() => insert('done')).not.toThrow();
	});

	it('keys on the Survey, the Labour and the verdict', () => {
		labour();
		const values = row();
		db.insert(outcomes).values(values).run();
		expect(() => db.insert(outcomes).values(values).run()).toThrow(/UNIQUE|PRIMARY/);
		expect(() =>
			db
				.insert(outcomes)
				.values({ ...values, verdict: 'done' })
				.run()
		).not.toThrow();
	});

	it('needs an existing Survey, Labour and author', () => {
		labour();
		expect(() =>
			db
				.insert(outcomes)
				.values(row({ surveyId: 999 }))
				.run()
		).toThrow(/FOREIGN KEY/);
		expect(() =>
			db
				.insert(outcomes)
				.values(row({ labourId: 999 }))
				.run()
		).toThrow(/FOREIGN KEY/);
		expect(() =>
			db
				.insert(outcomes)
				.values(row({ authorId: 999 }))
				.run()
		).toThrow(/FOREIGN KEY/);
	});

	it('goes with its Survey, whether deleted or pruned', () => {
		labour();
		const first = row();
		db.insert(outcomes).values(first).run();
		db.delete(surveys).where(eq(surveys.id, first.surveyId)).run();
		expect(stored()).toEqual([]);

		const second = row();
		db.insert(outcomes).values(second).run();
		expect(pruneSurveys(db, DAY, NOW.getTime() + 2 * DAY)).toBe(1);
		expect(stored()).toEqual([]);
	});

	it('goes with its Labour', () => {
		const made = labour();
		db.insert(outcomes).values(row()).run();
		deleteLabour(db, actor, made.id);
		expect(stored()).toEqual([]);
	});
});

describe('reportOutcomes', () => {
	it('refuses a Labour that the limit cut from the results', () => {
		const first = labour();
		const second = labour();
		const { surveyId, results } = ask(1);
		const cut = [first, second].find((l) => l.id !== results[0].labourId)!;

		expect(() =>
			reportOutcomes(db, actor, surveyId, [{ labourId: cut.id, verdict: 'picked' }], NOW)
		).toThrow(/not among/);
		expect(stored()).toEqual([]);
		expect(db.select().from(pulses).all()).toEqual([]);
	});

	it('stores nothing when a later item is refused', () => {
		const first = labour();
		const { surveyId } = ask();

		expect(() =>
			reportOutcomes(
				db,
				actor,
				surveyId,
				[
					{ labourId: first.id, verdict: 'picked' },
					{ labourId: first.id, verdict: 'bogus' as never }
				],
				NOW
			)
		).toThrow(/verdict/);
		expect(stored()).toEqual([]);
		expect(db.select().from(pulses).all()).toEqual([]);
	});

	it('refuses a Labour deleted since the Survey', () => {
		const gone = labour();
		const { surveyId } = ask();
		deleteLabour(db, actor, gone.id);

		expect(() =>
			reportOutcomes(db, actor, surveyId, [{ labourId: gone.id, verdict: 'done' }], NOW)
		).toThrow(/does not exist/);
	});

	it('posts no Pulse for a repeat, even inside one batch', () => {
		const made = labour();
		const { surveyId } = ask();
		const item = { labourId: made.id, verdict: 'picked' as const };

		const results = reportOutcomes(db, actor, surveyId, [item, item], NOW);

		expect(results.map((r) => r.recorded)).toEqual([true, false]);
		expect(db.select().from(pulses).all()).toHaveLength(2);
	});

	it('skips a value at the bottom of a scale', () => {
		const made = labour({ impact: 0, topic: ['ui'] });
		const { surveyId } = ask();

		reportOutcomes(db, actor, surveyId, [{ labourId: made.id, verdict: 'picked' }], NOW);

		expect(db.select({ rawKey: pulses.rawKey }).from(pulses).all()).toEqual([
			{ rawKey: 'topic:ui' }
		]);
	});

	it('files an Affinity Pulse under the Realm of the Labour, for the Survey User', () => {
		const other = seedUser(db, 'other');
		const made = labour();
		const { surveyId } = ask(15, other);

		reportOutcomes(db, actor, surveyId, [{ labourId: made.id, verdict: 'done' }], NOW);

		const view = readAffinity(db, other, { now: NOW });
		expect(view.keys.map((k) => [k.realmId, k.key])).toEqual([
			[realmId, 'topic:boss'],
			[realmId, 'impact']
		]);
		expect(readAffinity(db, actor.id, { now: NOW }).keys).toEqual([]);
	});
});

describe('the affinity feature', () => {
	function statements(run: () => void): number {
		const spy = vi.spyOn(db.$client, 'prepare');
		run();
		const calls = spy.mock.calls.length;
		spy.mockRestore();
		return calls;
	}

	it('runs the same number of statements however many Labours it scores', () => {
		const run = () => survey(db, actor, { weights: { affinity: 1 }, temperature: 0 }, { now: NOW });
		const first = labour();
		reportOutcomes(db, actor, ask().surveyId, [{ labourId: first.id, verdict: 'picked' }], NOW);
		const few = statements(run);
		for (let i = 0; i < 40; i += 1) labour();

		expect(statements(run)).toBe(few);
	});

	it('scores a Labour 0, never missing, when the User has no Affinity', () => {
		labour();

		const result = survey(db, actor, { weights: { affinity: 1 }, temperature: 0 }, { now: NOW });

		expect(result.results[0].score).toBe(0);
		expect(result.coverage.missing).toEqual({});
	});
});
