import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function scale(realmId: number, key: string, min: number, max: number) {
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'scale',
		label: key,
		rubric: 'rubric',
		spec: { min, max }
	});
}

function tags(realmId: number, key: string, members: string[]) {
	defineAttribute(db, actor, realmId, {
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
function learn(userId: number, labourId: number, verdict: Verdict, at = NOW) {
	const { surveyId } = survey(
		db,
		actor,
		{ weights: { evidence: 1 }, temperature: 0, forUserId: userId, limit: 50 },
		{ now: at }
	);
	reportOutcomes(db, actor, surveyId, [{ labourId, verdict }], at);
}

function rank(input: Partial<SurveyInput> = {}, at = NOW) {
	return survey(
		db,
		actor,
		{ weights: { affinity: 1 }, temperature: 0, limit: 50, ...input },
		{ now: at }
	);
}

function scored(labourId: number, input: Partial<SurveyInput> = {}, at = NOW) {
	return rank(input, at).results.find((r) => r.labourId === labourId)!;
}

const v = (volume: number) => volume / (volume + 5);

// AM with impact and effort on 0-4 and area ui, audio, net; alice, bob.
function world() {
	const am = seedRealm(db, 'AM');
	scale(am.id, 'impact', 0, 4);
	scale(am.id, 'effort', 0, 4);
	tags(am.id, 'area', ['ui', 'audio', 'net']);
	const bob = seedUser(db, 'bob');
	const alice = seedUser(db, 'alice');
	const labour = (values: Record<string, unknown>, title = 'Labour') => {
		const made = seedLabour(db, { realmId: am.id, title });
		set(made.id, values);
		return made;
	};
	return { am, bob, alice, labour };
}

describe('the affinity feature', () => {
	it('is a built-in feature, no longer later', () => {
		expect(Object.keys(FEATURES)).toContain('affinity');
		expect(LATER_FEATURES).not.toContain('affinity');
		expect(LATER_FEATURES).toContain('similarity');
	});

	it('is not ignored when weighted, while a feature not computed still is', () => {
		const { bob } = world();

		const result = rank({
			forUserId: bob,
			weights: { affinity: 1, similarity: 1, evidence: 1 }
		});

		expect(result.ignored).toEqual(['similarity']);
	});

	it('combines every held key of the candidate: delight and pain from the User Affinity', () => {
		const { bob, labour } = world();
		// Affinity of bob after these four:
		//   impact      volume 1 + 0.125 + 2   = 3.125, mood 2.875 / 3.125
		//   area:ui     volume 1,                       mood 1
		//   area:audio  volume 0.25 + 2        = 2.25,  mood 1.75 / 2.25
		//   effort      volume 0.5,                     mood -1
		//   area:net    volume 0.5,                     mood -1
		learn(bob, labour({ impact: 4, area: ['ui'] }).id, 'picked');
		learn(bob, labour({ impact: 2, area: ['audio'] }).id, 'skipped', daysAgo(30));
		learn(bob, labour({ impact: 4, area: ['audio'] }).id, 'done');
		learn(bob, labour({ effort: 4, area: ['net'] }).id, 'skipped');
		const candidate = labour({ impact: 2, effort: 2, area: ['ui', 'audio', 'net'] }, 'Candidate');

		const delight =
			1 -
			(1 - v(3.125) * (2.875 / 3.125) * 0.5) * // impact, x 0.5
				(1 - v(1) * 1 * 1) * // area:ui
				(1 - v(2.25) * (1.75 / 2.25) * 1); // area:audio
		const pain =
			1 -
			(1 - v(0.5) * 1 * 0.5) * // effort, x 0.5
				(1 - v(0.5) * 1 * 1); // area:net

		const result = scored(candidate.id, { forUserId: bob });

		expect(delight).toBeGreaterThan(0.4);
		expect(pain).toBeGreaterThan(0.1);
		expect(result.score).toBeCloseTo(delight - pain, 10);
		expect(result.contributions.affinity).toBeCloseTo(delight - pain, 10);
	});

	it('multiplies by the weight and keeps its sign for a negative weight', () => {
		const { bob, labour } = world();
		learn(bob, labour({ impact: 4 }).id, 'picked');
		const candidate = labour({ impact: 4 }, 'Candidate');
		const feature = v(1);

		const plus = scored(candidate.id, { forUserId: bob, weights: { affinity: 2 } });
		const minus = scored(candidate.id, { forUserId: bob, weights: { affinity: -3 } });

		expect(plus.score).toBeCloseTo(2 * feature, 10);
		expect(plus.contributions.affinity).toBeCloseTo(2 * feature, 10);
		expect(minus.score).toBeCloseTo(-3 * feature, 10);
	});

	it('scores positive after picks, and ranks a Labour like the picked ones first', () => {
		const { bob, labour } = world();
		const unlike = labour({ effort: 4, area: ['audio'] }, 'Unlike');
		const like = labour({ impact: 2, area: ['ui'] }, 'Like');
		learn(bob, labour({ impact: 4, area: ['ui'] }, 'Taken').id, 'picked');

		const result = rank({ forUserId: bob });

		const expected = 1 - (1 - v(1) * 1 * 0.5) * (1 - v(1) * 1 * 1);
		expect(scored(like.id, { forUserId: bob }).score).toBeCloseTo(expected, 10);
		expect(scored(unlike.id, { forUserId: bob }).score).toBeCloseTo(0, 10);
		const order = result.results.map((r) => r.labourId);
		expect(order.indexOf(like.id)).toBeLessThan(order.indexOf(unlike.id));
	});

	it('scores negative after skips, and ranks a Labour like the skipped ones last', () => {
		const { bob, labour } = world();
		const like = labour({ impact: 4, area: ['ui'] }, 'Like');
		const unlike = labour({ effort: 4, area: ['audio'] }, 'Unlike');
		learn(bob, labour({ impact: 4, area: ['ui'] }, 'Passed').id, 'skipped');

		const result = rank({ forUserId: bob });

		const pain = 1 - (1 - v(0.5)) * (1 - v(0.5));
		expect(scored(like.id, { forUserId: bob }).score).toBeCloseTo(-pain, 10);
		expect(scored(unlike.id, { forUserId: bob }).score).toBeCloseTo(0, 10);
		const order = result.results.map((r) => r.labourId);
		expect(order.indexOf(unlike.id)).toBeLessThan(order.indexOf(like.id));
	});

	it('nets a key the User both picks and skips by its mood', () => {
		const { bob, labour } = world();
		learn(bob, labour({ impact: 4 }).id, 'picked', daysAgo(30));
		learn(bob, labour({ impact: 4 }).id, 'skipped');
		const candidate = labour({ impact: 4 }, 'Candidate');

		const result = scored(candidate.id, { forUserId: bob });

		expect(result.score).toBeCloseTo(0, 10);
	});

	it('reads the Affinity of the Survey User, not of the actor or anyone else', () => {
		const { bob, alice, labour } = world();
		learn(bob, labour({ impact: 4 }).id, 'picked');
		const candidate = labour({ impact: 4 }, 'Candidate');

		expect(scored(candidate.id, { forUserId: bob }).score).toBeCloseTo(v(1), 10);
		expect(scored(candidate.id, { forUserId: alice }).score).toBeCloseTo(0, 10);
		expect(scored(candidate.id).score).toBeCloseTo(0, 10);
	});

	it('reads the Affinity as of the Survey now', () => {
		const { bob, labour } = world();
		learn(bob, labour({ impact: 4 }).id, 'picked');
		const candidate = labour({ impact: 4 }, 'Candidate');

		const fresh = scored(candidate.id, { forUserId: bob }, NOW);
		const faded = scored(candidate.id, { forUserId: bob }, new Date(NOW.getTime() + 30 * DAY));

		expect(fresh.score).toBeCloseTo(v(1), 10);
		expect(faded.score).toBeCloseTo(v(0.5), 10);
	});

	it('looks only at keys of the candidate own Realm', () => {
		const { bob, labour } = world();
		const bl = seedRealm(db, 'BL');
		scale(bl.id, 'impact', 0, 4);
		const there = seedLabour(db, { realmId: bl.id, title: 'Elsewhere' });
		set(there.id, { impact: 4 });
		learn(bob, labour({ impact: 4 }).id, 'picked');

		const result = rank({ forUserId: bob });

		expect(result.results.find((r) => r.labourId === there.id)!.score).toBeCloseTo(0, 10);
	});

	it('learns in the Realm of the Labour that was taken on', () => {
		const { bob, labour } = world();
		const bl = seedRealm(db, 'BL');
		scale(bl.id, 'impact', 0, 4);
		const taken = seedLabour(db, { realmId: bl.id, title: 'Taken' });
		set(taken.id, { impact: 4 });
		const home = labour({ impact: 4 }, 'Home');
		const away = seedLabour(db, { realmId: bl.id, title: 'Away' });
		set(away.id, { impact: 4 });
		learn(bob, taken.id, 'done');

		expect(scored(away.id, { forUserId: bob }).score).toBeCloseTo(v(2), 10);
		expect(scored(home.id, { forUserId: bob }).score).toBeCloseTo(0, 10);
	});

	it('scores 0 for a Labour holding no values, and never counts it as missing', () => {
		const { am, bob, labour } = world();
		learn(bob, labour({ impact: 4, area: ['ui'] }).id, 'picked');
		const bare = seedLabour(db, { realmId: am.id, title: 'Bare' });

		const result = rank({ forUserId: bob });

		expect(result.results.find((r) => r.labourId === bare.id)!.score).toBeCloseTo(0, 10);
		expect(result.coverage.missing).toEqual({});
		expect(result.ignored).toEqual([]);
	});

	it('scores 0 for a User with no Affinity, and never counts it as missing', () => {
		const { alice, labour } = world();
		const held = labour({ impact: 4, area: ['ui'] });

		const result = rank({ forUserId: alice });

		expect(result.results.find((r) => r.labourId === held.id)!.score).toBeCloseTo(0, 10);
		expect(result.coverage.missing).toEqual({});
	});

	it('scores 0 for a candidate holding no key the User has learned', () => {
		const { bob, labour } = world();
		learn(bob, labour({ impact: 4 }).id, 'picked');
		const other = labour({ effort: 4, area: ['net'] }, 'Other');

		expect(scored(other.id, { forUserId: bob }).score).toBeCloseTo(0, 10);
	});

	it('approaches 1 without passing it however much the User has learned', () => {
		const { bob, labour } = world();
		const taken = labour({ impact: 4, effort: 4, area: ['ui', 'audio', 'net'] });
		for (let i = 0; i < 30; i++) learn(bob, taken.id, i % 2 ? 'done' : 'picked');
		const like = labour({ impact: 4, effort: 4, area: ['ui', 'audio', 'net'] }, 'Like');

		const { score } = scored(like.id, { forUserId: bob });

		expect(score).toBeGreaterThan(0.9);
		expect(score).toBeLessThanOrEqual(1);
	});
});
