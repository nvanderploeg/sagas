import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { defineAttribute, setValues } from '../attributes.ts';
import { reportOutcomes, type Verdict } from '../outcomes.ts';
import { FEATURES, LATER_FEATURES } from './features/index.ts';
import { survey, type SurveyInput } from './index.ts';

let db: Db;
let actor: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

async function scale(realmId: number, key: string, min: number, max: number) {
	await defineAttribute(db, actor, realmId, {
		key,
		kind: 'scale',
		label: key,
		rubric: 'rubric',
		spec: { min, max }
	});
}

async function tags(realmId: number, key: string, members: string[]) {
	await defineAttribute(db, actor, realmId, {
		key,
		kind: 'tags',
		label: key,
		rubric: 'rubric',
		spec: { members: members.map((member) => ({ key: member, label: member })) }
	});
}

const set = (labourId: number, values: Record<string, unknown>) =>
	setValues(db, actor, labourId, values);

// The User takes on `labourId` with `verdict`: a fresh Survey that returns it, then its Outcome.
async function learn(userId: number, labourId: number, verdict: Verdict, at = NOW) {
	const { surveyId } = await survey(
		db,
		actor,
		{ weights: { evidence: 1 }, temperature: 0, forUserId: userId, limit: 50 },
		{ now: at }
	);
	await reportOutcomes(db, actor, surveyId, [{ labourId, verdict }], at);
}

function rank(input: Partial<SurveyInput> = {}, at = NOW) {
	return survey(
		db,
		actor,
		{ weights: { affinity: 1 }, temperature: 0, limit: 50, ...input },
		{ now: at }
	);
}

async function scored(labourId: number, input: Partial<SurveyInput> = {}, at = NOW) {
	return (await rank(input, at)).results.find((r) => r.labourId === labourId)!;
}

const v = (volume: number) => volume / (volume + 5);

// AM with impact and effort on 0-4 and area ui, audio, net; alice, bob.
async function world() {
	const am = await seedRealm(db, 'AM');
	await scale(am.id, 'impact', 0, 4);
	await scale(am.id, 'effort', 0, 4);
	await tags(am.id, 'area', ['ui', 'audio', 'net']);
	const bob = await seedUser(db, 'bob');
	const alice = await seedUser(db, 'alice');
	const labour = async (values: Record<string, unknown>, title = 'Labour') => {
		const made = await seedLabour(db, { realmId: am.id, title });
		await set(made.id, values);
		return made;
	};
	return { am, bob, alice, labour };
}

describe('the affinity feature', () => {
	it('is a built-in feature, no longer later', () => {
		expect(Object.keys(FEATURES)).toContain('affinity');
		expect(LATER_FEATURES).not.toContain('affinity');
		expect(LATER_FEATURES).toEqual([]);
	});

	it('is not ignored when weighted, while similarity without a query still is', async () => {
		const { bob } = await world();

		const result = await rank({
			forUserId: bob,
			weights: { affinity: 1, similarity: 1, evidence: 1 }
		});

		expect(result.ignored).toEqual(['similarity']);
	});

	it('combines every held key of the candidate: delight and pain from the User Affinity', async () => {
		const { bob, labour } = await world();
		// Affinity of bob after these four:
		//   impact      volume 1 + 0.125 + 2   = 3.125, mood 2.875 / 3.125
		//   area:ui     volume 1,                       mood 1
		//   area:audio  volume 0.25 + 2        = 2.25,  mood 1.75 / 2.25
		//   effort      volume 0.5,                     mood -1
		//   area:net    volume 0.5,                     mood -1
		await learn(bob, (await labour({ impact: 4, area: ['ui'] })).id, 'picked');
		await learn(bob, (await labour({ impact: 2, area: ['audio'] })).id, 'skipped', daysAgo(30));
		await learn(bob, (await labour({ impact: 4, area: ['audio'] })).id, 'done');
		await learn(bob, (await labour({ effort: 4, area: ['net'] })).id, 'skipped');
		const candidate = await labour(
			{ impact: 2, effort: 2, area: ['ui', 'audio', 'net'] },
			'Candidate'
		);

		const delight =
			1 -
			(1 - v(3.125) * (2.875 / 3.125) * 0.5) * // impact, x 0.5
				(1 - v(1) * 1 * 1) * // area:ui
				(1 - v(2.25) * (1.75 / 2.25) * 1); // area:audio
		const pain =
			1 -
			(1 - v(0.5) * 1 * 0.5) * // effort, x 0.5
				(1 - v(0.5) * 1 * 1); // area:net

		const result = await scored(candidate.id, { forUserId: bob });

		expect(delight).toBeGreaterThan(0.4);
		expect(pain).toBeGreaterThan(0.1);
		expect(result.score).toBeCloseTo(delight - pain, 10);
		expect(result.contributions.affinity).toBeCloseTo(delight - pain, 10);
	});

	it('multiplies by the weight and keeps its sign for a negative weight', async () => {
		const { bob, labour } = await world();
		await learn(bob, (await labour({ impact: 4 })).id, 'picked');
		const candidate = await labour({ impact: 4 }, 'Candidate');
		const feature = v(1);

		const plus = await scored(candidate.id, { forUserId: bob, weights: { affinity: 2 } });
		const minus = await scored(candidate.id, { forUserId: bob, weights: { affinity: -3 } });

		expect(plus.score).toBeCloseTo(2 * feature, 10);
		expect(plus.contributions.affinity).toBeCloseTo(2 * feature, 10);
		expect(minus.score).toBeCloseTo(-3 * feature, 10);
	});

	it('scores positive after picks, and ranks a Labour like the picked ones first', async () => {
		const { bob, labour } = await world();
		const unlike = await labour({ effort: 4, area: ['audio'] }, 'Unlike');
		const like = await labour({ impact: 2, area: ['ui'] }, 'Like');
		await learn(bob, (await labour({ impact: 4, area: ['ui'] }, 'Taken')).id, 'picked');

		const result = await rank({ forUserId: bob });

		const expected = 1 - (1 - v(1) * 1 * 0.5) * (1 - v(1) * 1 * 1);
		expect((await scored(like.id, { forUserId: bob })).score).toBeCloseTo(expected, 10);
		expect((await scored(unlike.id, { forUserId: bob })).score).toBeCloseTo(0, 10);
		const order = result.results.map((r) => r.labourId);
		expect(order.indexOf(like.id)).toBeLessThan(order.indexOf(unlike.id));
	});

	it('scores negative after skips, and ranks a Labour like the skipped ones last', async () => {
		const { bob, labour } = await world();
		const like = await labour({ impact: 4, area: ['ui'] }, 'Like');
		const unlike = await labour({ effort: 4, area: ['audio'] }, 'Unlike');
		await learn(bob, (await labour({ impact: 4, area: ['ui'] }, 'Passed')).id, 'skipped');

		const result = await rank({ forUserId: bob });

		const pain = 1 - (1 - v(0.5)) * (1 - v(0.5));
		expect((await scored(like.id, { forUserId: bob })).score).toBeCloseTo(-pain, 10);
		expect((await scored(unlike.id, { forUserId: bob })).score).toBeCloseTo(0, 10);
		const order = result.results.map((r) => r.labourId);
		expect(order.indexOf(unlike.id)).toBeLessThan(order.indexOf(like.id));
	});

	it('nets a key the User both picks and skips by its mood', async () => {
		const { bob, labour } = await world();
		await learn(bob, (await labour({ impact: 4 })).id, 'picked', daysAgo(30));
		await learn(bob, (await labour({ impact: 4 })).id, 'skipped');
		const candidate = await labour({ impact: 4 }, 'Candidate');

		const result = await scored(candidate.id, { forUserId: bob });

		expect(result.score).toBeCloseTo(0, 10);
	});

	it('reads the Affinity of the Survey User, not of the actor or anyone else', async () => {
		const { bob, alice, labour } = await world();
		await learn(bob, (await labour({ impact: 4 })).id, 'picked');
		const candidate = await labour({ impact: 4 }, 'Candidate');

		expect((await scored(candidate.id, { forUserId: bob })).score).toBeCloseTo(v(1), 10);
		expect((await scored(candidate.id, { forUserId: alice })).score).toBeCloseTo(0, 10);
		expect((await scored(candidate.id)).score).toBeCloseTo(0, 10);
	});

	it('reads the Affinity as of the Survey now', async () => {
		const { bob, labour } = await world();
		await learn(bob, (await labour({ impact: 4 })).id, 'picked');
		const candidate = await labour({ impact: 4 }, 'Candidate');

		const fresh = await scored(candidate.id, { forUserId: bob }, NOW);
		const faded = await scored(
			candidate.id,
			{ forUserId: bob },
			new Date(NOW.getTime() + 30 * DAY)
		);

		expect(fresh.score).toBeCloseTo(v(1), 10);
		expect(faded.score).toBeCloseTo(v(0.5), 10);
	});

	it('looks only at keys of the candidate own Realm', async () => {
		const { bob, labour } = await world();
		const bl = await seedRealm(db, 'BL');
		await scale(bl.id, 'impact', 0, 4);
		const there = await seedLabour(db, { realmId: bl.id, title: 'Elsewhere' });
		await set(there.id, { impact: 4 });
		await learn(bob, (await labour({ impact: 4 })).id, 'picked');

		const result = await rank({ forUserId: bob });

		expect(result.results.find((r) => r.labourId === there.id)!.score).toBeCloseTo(0, 10);
	});

	it('learns in the Realm of the Labour that was taken on', async () => {
		const { bob, labour } = await world();
		const bl = await seedRealm(db, 'BL');
		await scale(bl.id, 'impact', 0, 4);
		const taken = await seedLabour(db, { realmId: bl.id, title: 'Taken' });
		await set(taken.id, { impact: 4 });
		const home = await labour({ impact: 4 }, 'Home');
		const away = await seedLabour(db, { realmId: bl.id, title: 'Away' });
		await set(away.id, { impact: 4 });
		await learn(bob, taken.id, 'done');

		expect((await scored(away.id, { forUserId: bob })).score).toBeCloseTo(v(2), 10);
		expect((await scored(home.id, { forUserId: bob })).score).toBeCloseTo(0, 10);
	});

	it('scores 0 for a Labour holding no values, and never counts it as missing', async () => {
		const { am, bob, labour } = await world();
		await learn(bob, (await labour({ impact: 4, area: ['ui'] })).id, 'picked');
		const bare = await seedLabour(db, { realmId: am.id, title: 'Bare' });

		const result = await rank({ forUserId: bob });

		expect(result.results.find((r) => r.labourId === bare.id)!.score).toBeCloseTo(0, 10);
		expect(result.coverage.missing).toEqual({});
		expect(result.ignored).toEqual([]);
	});

	it('scores 0 for a User with no Affinity, and never counts it as missing', async () => {
		const { alice, labour } = await world();
		const held = await labour({ impact: 4, area: ['ui'] });

		const result = await rank({ forUserId: alice });

		expect(result.results.find((r) => r.labourId === held.id)!.score).toBeCloseTo(0, 10);
		expect(result.coverage.missing).toEqual({});
	});

	it('scores 0 for a candidate holding no key the User has learned', async () => {
		const { bob, labour } = await world();
		await learn(bob, (await labour({ impact: 4 })).id, 'picked');
		const other = await labour({ effort: 4, area: ['net'] }, 'Other');

		expect((await scored(other.id, { forUserId: bob })).score).toBeCloseTo(0, 10);
	});

	it('approaches 1 without passing it however much the User has learned', async () => {
		const { bob, labour } = await world();
		const taken = await labour({ impact: 4, effort: 4, area: ['ui', 'audio', 'net'] });
		for (let i = 0; i < 30; i++) await learn(bob, taken.id, i % 2 ? 'done' : 'picked');
		const like = await labour({ impact: 4, effort: 4, area: ['ui', 'audio', 'net'] }, 'Like');

		const { score } = await scored(like.id, { forUserId: bob });

		expect(score).toBeGreaterThan(0.9);
		expect(score).toBeLessThanOrEqual(1);
	});
});
