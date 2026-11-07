import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { outcomes, pulses, surveys } from '#lib/server/db/schema.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb, countStatements, expectFailure } from '#lib/server/test/db.ts';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
	await defineAttribute(db, actor, realmId, {
		key: 'impact',
		kind: 'scale',
		label: 'Impact',
		rubric: 'x',
		spec: { min: 0, max: 4 }
	});
	await defineAttribute(db, actor, realmId, {
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

const labour = async (values: Record<string, unknown> = { impact: 2, topic: ['boss'] }) => {
	const made = await seedLabour(db, { realmId });
	await setValues(db, actor, made.id, values);
	return made;
};

const ask = (limit = 15, forId = actor.id) =>
	survey(db, actor, { weights: { age: 1 }, temperature: 0, limit, forUserId: forId }, { now: NOW });

const stored = async () => await db.select().from(outcomes);

describe('the outcomes table', () => {
	const row = async (over: Partial<typeof outcomes.$inferInsert> = {}) => {
		const { surveyId, results } = await ask();
		return {
			surveyId,
			labourId: results[0]?.labourId ?? 0,
			verdict: 'picked' as const,
			authorId: actor.id,
			createdAt: NOW,
			...over
		};
	};

	it('refuses an unknown verdict', async () => {
		await labour();
		const insert = async (verdict: string) =>
			db.$client.query(
				`INSERT INTO outcomes (survey_id, labour_id, verdict, author_id, created_at)
				 VALUES ($1, $2, $3, $4, 0)`,
				[(await row()).surveyId, (await row()).labourId, verdict, actor.id]
			);
		await expectFailure(insert('abandoned'), /outcomes_verdict/);
		await expect(insert('done')).resolves.toBeDefined();
	});

	it('keys on the Survey, the Labour and the verdict', async () => {
		await labour();
		const values = await row();
		await db.insert(outcomes).values(values);
		await expectFailure(
			db.insert(outcomes).values(values),
			/outcomes_survey_id_labour_id_verdict_pk/
		);
		await expect(db.insert(outcomes).values({ ...values, verdict: 'done' })).resolves.toBeDefined();
	});

	it('needs an existing Survey, Labour and author', async () => {
		await labour();
		await expectFailure(db.insert(outcomes).values(await row({ surveyId: 999 })), /foreign key/);
		await expectFailure(db.insert(outcomes).values(await row({ labourId: 999 })), /foreign key/);
		await expectFailure(db.insert(outcomes).values(await row({ authorId: 999 })), /foreign key/);
	});

	it('goes with its Survey, whether deleted or pruned', async () => {
		await labour();
		const first = await row();
		await db.insert(outcomes).values(first);
		await db.delete(surveys).where(eq(surveys.id, first.surveyId));
		expect(await stored()).toEqual([]);

		const second = await row();
		await db.insert(outcomes).values(second);
		expect(await pruneSurveys(db, DAY, NOW.getTime() + 2 * DAY)).toBe(1);
		expect(await stored()).toEqual([]);
	});

	it('goes with its Labour', async () => {
		const made = await labour();
		await db.insert(outcomes).values(await row());
		await deleteLabour(db, actor, made.id);
		expect(await stored()).toEqual([]);
	});
});

describe('reportOutcomes', () => {
	it('refuses a Labour that the limit cut from the results', async () => {
		const first = await labour();
		const second = await labour();
		const { surveyId, results } = await ask(1);
		const cut = [first, second].find((l) => l.id !== results[0].labourId)!;

		await expectFailure(
			reportOutcomes(db, actor, surveyId, [{ labourId: cut.id, verdict: 'picked' }], NOW),
			/not among/
		);
		expect(await stored()).toEqual([]);
		expect(await db.select().from(pulses)).toEqual([]);
	});

	it('stores nothing when a later item is refused', async () => {
		const first = await labour();
		const { surveyId } = await ask();

		await expectFailure(
			reportOutcomes(
				db,
				actor,
				surveyId,
				[
					{ labourId: first.id, verdict: 'picked' },
					{ labourId: first.id, verdict: 'bogus' as never }
				],
				NOW
			),
			/verdict/
		);
		expect(await stored()).toEqual([]);
		expect(await db.select().from(pulses)).toEqual([]);
	});

	it('refuses a Labour deleted since the Survey', async () => {
		const gone = await labour();
		const { surveyId } = await ask();
		await deleteLabour(db, actor, gone.id);

		await expectFailure(
			reportOutcomes(db, actor, surveyId, [{ labourId: gone.id, verdict: 'done' }], NOW),
			/does not exist/
		);
	});

	it('posts no Pulse for a repeat, even inside one batch', async () => {
		const made = await labour();
		const { surveyId } = await ask();
		const item = { labourId: made.id, verdict: 'picked' as const };

		const results = await reportOutcomes(db, actor, surveyId, [item, item], NOW);

		expect(results.map((r) => r.recorded)).toEqual([true, false]);
		expect(await db.select().from(pulses)).toHaveLength(2);
	});

	it('skips a value at the bottom of a scale', async () => {
		const made = await labour({ impact: 0, topic: ['ui'] });
		const { surveyId } = await ask();

		await reportOutcomes(db, actor, surveyId, [{ labourId: made.id, verdict: 'picked' }], NOW);

		expect(await db.select({ rawKey: pulses.rawKey }).from(pulses)).toEqual([
			{ rawKey: 'topic:ui' }
		]);
	});

	it('files an Affinity Pulse under the Realm of the Labour, for the Survey User', async () => {
		const other = await seedUser(db, 'other');
		const made = await labour();
		const { surveyId } = await ask(15, other);

		await reportOutcomes(db, actor, surveyId, [{ labourId: made.id, verdict: 'done' }], NOW);

		const view = await readAffinity(db, other, { now: NOW });
		expect(view.keys.map((k) => [k.realmId, k.key])).toEqual([
			[realmId, 'topic:boss'],
			[realmId, 'impact']
		]);
		expect((await readAffinity(db, actor.id, { now: NOW })).keys).toEqual([]);
	});
});

describe('the affinity feature', () => {
	function statements(run: () => unknown): Promise<number> {
		return countStatements(run);
	}

	it('runs the same number of statements however many Labours it scores', async () => {
		const run = () => survey(db, actor, { weights: { affinity: 1 }, temperature: 0 }, { now: NOW });
		const first = await labour();
		await reportOutcomes(
			db,
			actor,
			(await ask()).surveyId,
			[{ labourId: first.id, verdict: 'picked' }],
			NOW
		);
		const few = await statements(run);
		for (let i = 0; i < 40; i += 1) await labour();

		expect(await statements(run)).toBe(few);
	});

	it('scores a Labour 0, never missing, when the User has no Affinity', async () => {
		await labour();

		const result = await survey(
			db,
			actor,
			{ weights: { affinity: 1 }, temperature: 0 },
			{ now: NOW }
		);

		expect(result.results[0].score).toBe(0);
		expect(result.coverage.missing).toEqual({});
	});
});
