import { and, eq } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	appraisals,
	comments,
	labourAttributes,
	labourKeys,
	labourNeeds,
	labours,
	links,
	mentions,
	pulses,
	questLabours,
	quests,
	states,
	surveys,
	userSkills
} from '#lib/server/db/schema.ts';
import { addComment, editComment } from '#lib/server/domain/comments.ts';
import { createState } from '#lib/server/domain/states.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise } from '../appraisals.ts';
import { defineAttribute, RESERVED, setValues } from '../attributes.ts';
import { contentHash, hashContent } from '../content.ts';
import { rebuildDerived } from '../derived.ts';
import { scheduleAgentPruning } from '../prune.ts';
import { defineSkill } from '../skills.ts';
import { FEATURES, LATER_FEATURES, type Feature } from './features/index.ts';
import { pruneSurveys, survey } from './index.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
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
	vi.useRealTimers();
	db.$client.close();
});

const labour = (over: Partial<Parameters<typeof seedLabour>[1]> = {}) =>
	seedLabour(db, { realmId, ...over });

const ask = (
	weights: Record<string, number>,
	more: Partial<Parameters<typeof survey>[2]> = {},
	opts: Parameters<typeof survey>[3] = {}
) => survey(db, actor, { weights, temperature: 0, ...more }, { now: NOW, ...opts });

const closedStateId = (realm: number) =>
	db
		.select({ id: states.id })
		.from(states)
		.where(and(eq(states.realmId, realm), eq(states.isClosed, true)))
		.get()!.id;

const stamp = (labourId: number) =>
	appraise(db, actor, [{ labourId, stamp: contentHash(db, labourId) }]);

describe('feature registry', () => {
	it('keeps every feature name reserved against Attribute keys', () => {
		for (const name of [...Object.keys(FEATURES), ...LATER_FEATURES]) {
			expect(RESERVED.has(name), name).toBe(true);
		}
	});

	it('names each feature by its registry key', () => {
		for (const [key, feature] of Object.entries(FEATURES)) expect(feature.name).toBe(key);
	});
});

describe('missing data from a feature', () => {
	afterEach(() => {
		delete (FEATURES as Record<string, Feature>).fake;
	});

	it('gives null 0.5 and counts it, and gives an absent candidate 0', () => {
		const a = labour();
		const b = labour();
		const c = labour();
		let seen: Float32Array | undefined;
		(FEATURES as Record<string, Feature>).fake = {
			name: 'fake',
			load({ queryVector }) {
				seen = queryVector;
				return new Map([
					[a.id, null],
					[b.id, 1]
				]);
			}
		};
		const vector = new Float32Array([1]);
		const result = ask({ fake: 2 }, {}, { queryVector: vector });
		const score = (id: number) => result.results.find((r) => r.labourId === id)!.score;
		expect([a.id, b.id, c.id].map(score)).toEqual([1, 2, 0]);
		expect(result.coverage.missing).toEqual({ fake: 1 });
		expect(seen).toBe(vector);
		const stored = db.select().from(surveys).get()!;
		expect(JSON.stringify(stored.request)).not.toContain('queryVector');
	});
});

describe('missing data outside the candidates', () => {
	afterEach(() => {
		delete (FEATURES as Record<string, Feature>).fake;
	});

	it('counts only candidates as missing', () => {
		const open = labour();
		const shut = labour({ stateId: closedStateId(realmId) });
		(FEATURES as Record<string, Feature>).fake = {
			name: 'fake',
			load() {
				return new Map([
					[open.id, null],
					[shut.id, null],
					[999_999, null]
				]);
			}
		};
		const result = ask({ fake: 1 });
		expect(result.coverage).toMatchObject({ candidates: 1, missing: { fake: 1 } });
	});
});

describe('content hashing', () => {
	it('hashContent agrees with contentHash', () => {
		const a = labour({ title: 'T', description: 'D', labels: ['bug'] });
		addComment(db, actor, a.id, 'one');
		addComment(db, actor, a.id, 'two');
		expect(
			hashContent({ title: 'T', description: 'D', labels: ['bug'], comments: ['one', 'two'] })
		).toBe(contentHash(db, a.id));
	});

	it('counts a stamped candidate stale after a Comment edit', () => {
		const a = labour();
		const b = labour();
		const comment = addComment(db, actor, a.id, 'first');
		stamp(a.id);
		stamp(b.id);
		expect(ask({ age: 1 }).coverage).toMatchObject({ unappraised: 0, stale: 0 });
		editComment(db, actor, comment.id, 'changed');
		expect(ask({ age: 1 }).coverage).toMatchObject({ unappraised: 0, stale: 1 });
	});
});

describe('querying', () => {
	function statements(run: () => void): number {
		const spy = vi.spyOn(db.$client, 'prepare');
		run();
		const calls = spy.mock.calls.length;
		spy.mockRestore();
		return calls;
	}

	it('runs the same number of statements however many Labours it scores', () => {
		const everything = {
			keywords: 1,
			mentions: 1,
			pulled_in: 1,
			evidence: 1,
			unblocks: 1,
			quest_finish: 1,
			column: 1,
			age: 1,
			activity: 1,
			sentiment: 1,
			pain: 1,
			delight: 1
		};
		const run = () => ask(everything, { query: 'labour' });
		for (let i = 0; i < 3; i += 1) stamp(labour().id);
		const few = statements(run);
		for (let i = 0; i < 40; i += 1) {
			const l = labour();
			addComment(db, actor, l.id, `note ${i}`);
			stamp(l.id);
		}
		expect(statements(run)).toBe(few);
	});
});

describe('board order', () => {
	it('orders Realm, State position, then Rank in code-unit order', () => {
		const other = seedRealm(db, 'BM').id;
		const doing = createState(db, actor, realmId, {
			key: 'doing',
			label: 'Doing',
			color: '#222222',
			icon: 'circle'
		});
		const late = labour({ title: 'doing', stateId: doing.id });
		const second = labour({ title: 'second' });
		const first = labour({ title: 'first' });
		const foreign = seedLabour(db, { realmId: other, title: 'foreign' });
		// 'B' sorts before 'a' by code unit, though not by locale.
		db.update(labours).set({ rank: 'a' }).where(eq(labours.id, second.id)).run();
		db.update(labours).set({ rank: 'B' }).where(eq(labours.id, first.id)).run();

		const keys = ask({ column: 0 }).results.map((r) => r.labourId);
		expect(keys).toEqual([first.id, second.id, late.id, foreign.id]);
	});

	it('keeps board order for equal Scores at temperature 0', () => {
		const ids = [labour().id, labour().id, labour().id];
		expect(ask({ age: 0 }).results.map((r) => r.labourId)).toEqual(ids);
	});
});

describe('temperature', () => {
	const draws = (values: number[]) => {
		let next = 0;
		const random = vi.fn(() => values[next++]);
		return random;
	};

	function scaled(...impacts: number[]): number[] {
		defineAttribute(db, actor, realmId, {
			key: 'impact',
			kind: 'scale',
			label: 'Impact',
			rubric: 'x',
			spec: { min: 1, max: 5 }
		});
		return impacts.map((impact) => {
			const l = labour();
			setValues(db, actor, l.id, { impact });
			return l.id;
		});
	}

	it('draws nothing at temperature 0', () => {
		scaled(1, 2);
		const random = draws([]);
		ask({ impact: 1 }, {}, { random });
		expect(random).not.toHaveBeenCalled();
	});

	it('draws once per candidate, in board order, and sorts by score plus Gumbel noise', () => {
		const [a, b, c] = scaled(1, 3, 5);
		const random = draws([0.9, 0.2, 0.5]);
		const temperature = 1.5;
		const result = ask({ impact: 4 }, { temperature }, { random });
		expect(random).toHaveBeenCalledTimes(3);

		const scores = [0, 2, 4];
		const mean = 2;
		const sigma = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / 3);
		const keys = [0.9, 0.2, 0.5].map(
			(u, i) => scores[i] + temperature * sigma * -Math.log(-Math.log(u))
		);
		const expected = [a, b, c]
			.map((id, i) => ({ id, key: keys[i] }))
			.sort((x, y) => y.key - x.key)
			.map((x) => x.id);
		expect(result.results.map((r) => r.labourId)).toEqual(expected);
		expect(result.results.map((r) => r.score).sort()).toEqual([0, 2, 4]);
	});

	it('clamps draws of exactly 0 and 1', () => {
		scaled(1, 5);
		const result = ask({ impact: 4 }, { temperature: 2 }, { random: draws([0, 1]) });
		expect(result.results).toHaveLength(2);
		for (const item of result.results) expect(Number.isFinite(item.score)).toBe(true);
	});

	it('adds no noise when fewer than two candidates', () => {
		scaled(3);
		expect(ask({ impact: 4 }, { temperature: 2 }, { random: draws([0.5]) }).results).toHaveLength(
			1
		);
	});
});

describe('features', () => {
	it('scores the built-in formulas', () => {
		const user = seedUser(db, 'reader');
		const a = labour({ title: 'alpha' });
		const b = labour({ title: 'beta' });
		const c = labour({ title: 'gamma' });
		db.update(labours)
			.set({ createdAt: ago(30), updatedAt: ago(7) })
			.where(eq(labours.id, a.id))
			.run();
		db.update(labours)
			.set({ createdAt: ago(0), updatedAt: ago(0) })
			.where(eq(labours.id, b.id))
			.run();
		db.update(labours)
			.set({ createdAt: ago(60), updatedAt: ago(70) })
			.where(eq(labours.id, c.id))
			.run();
		addComment(db, actor, c.id, 'later');
		db.update(comments)
			.set({ createdAt: ago(14) })
			.where(eq(comments.labourId, c.id))
			.run();

		db.insert(mentions)
			.values([
				{ sourceLabourId: b.id, labourId: a.id, authorId: actor.id, firstSeenAt: ago(7) },
				{ sourceLabourId: c.id, labourId: a.id, authorId: actor.id, firstSeenAt: ago(0) },
				{ sourceLabourId: a.id, userId: user, authorId: actor.id, firstSeenAt: ago(14) }
			])
			.run();
		db.insert(links)
			.values([
				{ fromId: b.id, toId: a.id, type: 'evidence', setBy: actor.id },
				{ fromId: c.id, toId: a.id, type: 'evidence', setBy: actor.id },
				{ fromId: a.id, toId: b.id, type: 'blocks', setBy: actor.id },
				{ fromId: a.id, toId: c.id, type: 'blocks', setBy: actor.id }
			])
			.run();

		const scoreOf = (feature: string, id: number) =>
			survey(
				db,
				actor,
				{ weights: { [feature]: 1 }, temperature: 0, forUserId: user, limit: 50 },
				{ now: NOW }
			).results.find((r) => r.labourId === id)!.score;
		expect(scoreOf('mentions', a.id)).toBeCloseTo(1 - 2 ** -(2 ** -1 + 1), 12);
		expect(scoreOf('pulled_in', a.id)).toBeCloseTo(1 - 2 ** -(2 ** -2), 12);
		expect(scoreOf('pulled_in', b.id)).toBe(0);
		expect(scoreOf('evidence', a.id)).toBeCloseTo(2 / 4, 12);
		expect(scoreOf('unblocks', a.id)).toBeCloseTo(2 / 4, 12);
		expect(scoreOf('unblocks', b.id)).toBe(0);
		expect(scoreOf('age', a.id)).toBeCloseTo(30 / 60, 12);
		expect(scoreOf('age', b.id)).toBe(0);
		expect(scoreOf('activity', a.id)).toBeCloseTo(2 ** -1, 12);
		expect(scoreOf('activity', b.id)).toBeCloseTo(1, 12);
		expect(scoreOf('activity', c.id)).toBeCloseTo(2 ** -2, 12);
	});

	it('scores quest_finish across Realms and leaves Closed Labours at 0', () => {
		const other = seedRealm(db, 'BM').id;
		const a = labour();
		const b = seedLabour(db, { realmId: other });
		const done = seedLabour(db, { realmId: other, stateId: closedStateId(other) });
		const lone = labour();
		const quest = db.insert(quests).values({ name: 'Q', ownerId: actor.id }).returning().get();
		const [r1, r2, r3] = generateNKeysBetween(null, null, 3);
		db.insert(questLabours)
			.values([
				{ questId: quest.id, labourId: a.id, rank: r1 },
				{ questId: quest.id, labourId: b.id, rank: r2 },
				{ questId: quest.id, labourId: done.id, rank: r3 }
			])
			.run();

		const result = ask({ quest_finish: 1 }, { filter: { includeClosed: true } });
		const score = (id: number) => result.results.find((r) => r.labourId === id)!.score;
		expect(score(a.id)).toBeCloseTo(2 / 3, 12);
		expect(score(b.id)).toBeCloseTo(2 / 3, 12);
		expect(score(done.id)).toBe(0);
		expect(score(lone.id)).toBe(0);
	});

	it('scores column over the whole column, not only the candidates', () => {
		const a = labour();
		const b = labour({ assigneeId: seedUser(db, 'someone') });
		const c = labour();
		const lone = createState(db, actor, realmId, {
			key: 'solo',
			label: 'Solo',
			color: '#333333',
			icon: 'circle'
		});
		const only = labour({ stateId: lone.id });
		const all = ask({ column: 1 });
		const score = (id: number) => all.results.find((r) => r.labourId === id)!.score;
		expect([a.id, b.id, c.id].map(score)).toEqual([1, 0.5, 0]);
		expect(score(only.id)).toBe(1);

		const middle = ask(
			{ column: 1 },
			{
				filter: {
					assigneeIds: [db.select().from(labours).where(eq(labours.id, b.id)).get()!.assigneeId]
				}
			}
		);
		expect(middle.results.map((r) => [r.labourId, r.score])).toEqual([[b.id, 0.5]]);
	});

	it('rescales keywords over the candidates, not every Labour', () => {
		const strong = labour({ title: 'boss boss boss fight', assigneeId: seedUser(db, 'u1') });
		const weak = labour({ title: 'boss', description: 'unrelated filler text here too' });
		labour({ title: 'nothing' });
		const everyone = ask({ keywords: 1 }, { query: 'boss fight' });
		expect(everyone.results[0]).toMatchObject({ labourId: strong.id, score: 1 });

		const narrowed = ask({ keywords: 1 }, { query: 'boss fight', filter: { assigneeIds: [null] } });
		expect(narrowed.results[0]).toMatchObject({ labourId: weak.id, score: 1 });
		expect(narrowed.results.at(-1)!.score).toBe(0);
	});

	it('takes 0.5 and counts it for an Attribute the Labour lacks, and 0 for a held tags without the member', () => {
		const other = seedRealm(db, 'BM').id;
		defineAttribute(db, actor, realmId, {
			key: 'impact',
			kind: 'scale',
			label: 'I',
			rubric: 'x',
			spec: { min: 0, max: 10 }
		});
		defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			label: 'T',
			rubric: 'x',
			spec: {
				members: [
					{ key: 'ui', label: 'UI' },
					{ key: 'audio', label: 'Audio' }
				]
			}
		});
		const set = labour();
		const unset = labour();
		const away = seedLabour(db, { realmId: other });
		setValues(db, actor, set.id, { impact: 5, topic: ['audio'] });

		const result = ask({ impact: 2, 'topic:ui': 4 }, { limit: 50 });
		const item = (id: number) => result.results.find((r) => r.labourId === id)!;
		expect(item(set.id).score).toBeCloseTo(2 * 0.5 + 0, 12);
		expect(item(unset.id).score).toBeCloseTo(2 * 0.5 + 4 * 0.5, 12);
		expect(item(away.id).score).toBeCloseTo(2 * 0.5 + 4 * 0.5, 12);
		expect(result.coverage.missing).toEqual({ impact: 2, 'topic:ui': 2 });
	});

	it('shows values as stored, in show order, omitting unset ones', () => {
		defineAttribute(db, actor, realmId, {
			key: 'impact',
			kind: 'scale',
			label: 'I',
			rubric: 'x',
			spec: { min: 0, max: 10 }
		});
		defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			label: 'T',
			rubric: 'x',
			spec: {
				members: [
					{ key: 'ui', label: 'UI' },
					{ key: 'audio', label: 'Audio' }
				]
			}
		});
		defineAttribute(db, actor, realmId, { key: 'why', kind: 'text', label: 'W', rubric: 'x' });
		const a = labour();
		const b = labour();
		setValues(db, actor, a.id, { impact: 7, topic: ['ui', 'audio'], why: 'because' });
		const result = ask({ age: 1 }, { show: ['topic', 'why', 'impact', 'nope'] });
		expect(Object.keys(result.results[0].values!)).toEqual(['topic', 'why', 'impact']);
		expect(result.results[0].values).toEqual({ topic: ['audio', 'ui'], why: 'because', impact: 7 });
		expect(result.results.find((r) => r.labourId === b.id)!.values).toEqual({});
		expect(result.ignored).toEqual(['nope']);
	});
});

describe('weights', () => {
	it('puts unmatched, later and keywords-without-query keys in ignored, weights before show', () => {
		const old = labour();
		db.update(labours)
			.set({ createdAt: ago(30) })
			.where(eq(labours.id, old.id))
			.run();
		const result = ask(
			{ similarity: 1, rank: 1, priority: 1, keywords: 1, bogus: 1, 'bogus:one': 1, age: 1 },
			{ show: ['absent'] }
		);
		expect(result.ignored).toEqual([
			'similarity',
			'rank',
			'priority',
			'keywords',
			'bogus',
			'bogus:one',
			'absent'
		]);
		expect(Object.keys(result.results[0].contributions)).toEqual(['age']);
	});

	it('ignores a bare tags or text key', () => {
		defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			label: 'T',
			rubric: 'x',
			spec: { members: [{ key: 'ui', label: 'UI' }] }
		});
		defineAttribute(db, actor, realmId, { key: 'why', kind: 'text', label: 'W', rubric: 'x' });
		labour();
		expect(ask({ topic: 1, why: 1, 'why:ui': 1 }).ignored).toEqual(['topic', 'why', 'why:ui']);
	});

	it('lists the five largest contributions by size, ties in weight order, without zeros', () => {
		const a = labour();
		db.update(labours)
			.set({ createdAt: ago(30) })
			.where(eq(labours.id, a.id))
			.run();
		db.insert(links)
			.values({ fromId: labour().id, toId: a.id, type: 'evidence', setBy: actor.id })
			.run();
		const result = ask({ age: 2, evidence: -4, mentions: 3, unblocks: 3, activity: 0.01 });
		const only = result.results.find((r) => r.labourId === a.id)!;
		expect(Object.keys(only.contributions)).toEqual(['evidence', 'age', 'activity']);
	});
});

describe('filters', () => {
	it('adds Closed Labours by includeClosed', () => {
		const open = labour();
		const recent = labour({ stateId: closedStateId(realmId) });
		const old = labour({ stateId: closedStateId(realmId) });
		db.update(labours)
			.set({ updatedAt: ago(3) })
			.where(eq(labours.id, recent.id))
			.run();
		db.update(labours)
			.set({ updatedAt: ago(40) })
			.where(eq(labours.id, old.id))
			.run();
		const ids = (filter?: Parameters<typeof survey>[2]['filter']) =>
			ask({ age: 1 }, { filter, limit: 50 }).results.map((r) => r.labourId);
		expect(ids()).toEqual([open.id]);
		expect(ids({ includeClosed: true })).toEqual([open.id, recent.id, old.id]);
		expect(ids({ includeClosed: { withinDays: 30 } })).toEqual([open.id, recent.id]);
	});

	it('filters by assignee, labels, has, quest and unblocked', () => {
		defineAttribute(db, actor, realmId, {
			key: 'topic',
			kind: 'tags',
			label: 'T',
			rubric: 'x',
			spec: {
				members: [
					{ key: 'ui', label: 'UI' },
					{ key: 'audio', label: 'A' }
				]
			}
		});
		const ada = seedUser(db, 'ada1');
		const a = labour({ assigneeId: ada, labels: ['bug', 'ui'] });
		const b = labour({ labels: ['bug'] });
		const c = labour({ assigneeId: ada });
		setValues(db, actor, a.id, { topic: ['ui'] });
		setValues(db, actor, b.id, { topic: ['audio'] });
		const [rank] = generateNKeysBetween(null, null, 1);
		const quest = db.insert(quests).values({ name: 'Q', ownerId: actor.id }).returning().get();
		db.insert(questLabours).values({ questId: quest.id, labourId: c.id, rank }).run();
		db.insert(links).values({ fromId: a.id, toId: c.id, type: 'blocks', setBy: actor.id }).run();

		const ids = (filter: NonNullable<Parameters<typeof survey>[2]['filter']>) =>
			ask({ age: 1 }, { filter, limit: 50 }).results.map((r) => r.labourId);
		expect(ids({ assigneeIds: [ada] })).toEqual([a.id, c.id]);
		expect(ids({ assigneeIds: [null] })).toEqual([b.id]);
		expect(ids({ assigneeIds: [ada, null] })).toEqual([a.id, b.id, c.id]);
		expect(ids({ labels: ['bug'] })).toEqual([a.id, b.id]);
		expect(ids({ labels: ['BUG', 'ui'] })).toEqual([a.id]);
		expect(ids({ has: ['topic:ui'] })).toEqual([a.id]);
		expect(ids({ has: ['topic:ui', 'topic:audio'] })).toEqual([]);
		expect(ids({ has: ['nope:ui'] })).toEqual([]);
		expect(ids({ questId: quest.id })).toEqual([c.id]);
		expect(ids({ unblocked: true })).toEqual([a.id, b.id]);

		db.update(labours)
			.set({ stateId: closedStateId(realmId) })
			.where(eq(labours.id, a.id))
			.run();
		expect(ids({ unblocked: true })).toEqual([b.id, c.id]);
	});
});

describe('storage', () => {
	it('stores the request and results and changes nothing else', () => {
		const a = labour();
		const before = db.select().from(labours).where(eq(labours.id, a.id)).get()!.updatedAt;
		const result = ask({ age: 1 }, { query: '  hello  ', show: ['x'] });
		const row = db.select().from(surveys).where(eq(surveys.id, result.surveyId)).get()!;
		expect(row.createdAt).toEqual(NOW);
		expect(row.actorId).toBe(actor.id);
		expect(row.forId).toBe(actor.id);
		expect(row.results).toEqual([{ labour: a.id, score: result.results[0].score }]);
		expect(row.request).toMatchObject({
			realmIds: [realmId],
			forUserId: actor.id,
			query: 'hello',
			weights: { age: 1 },
			temperature: 0,
			limit: 15,
			show: ['x']
		});
		expect(db.select().from(labours).where(eq(labours.id, a.id)).get()!.updatedAt).toEqual(before);
	});

	it('prunes only Surveys older than the retention', () => {
		labour();
		const old = ask({ age: 1 }, {}, { now: ago(31) }).surveyId;
		const edge = ask({ age: 1 }, {}, { now: ago(30) }).surveyId;
		const fresh = ask({ age: 1 }).surveyId;
		expect(pruneSurveys(db, 30 * DAY, NOW.getTime())).toBe(1);
		expect(
			db
				.select({ id: surveys.id })
				.from(surveys)
				.all()
				.map((r) => r.id)
		).toEqual([edge, fresh]);
		expect(old).toBeLessThan(edge);
	});

	it('prunes at startup and on the interval, and stops when told', () => {
		vi.useFakeTimers({ now: NOW });
		labour();
		ask({ age: 1 }, {}, { now: ago(40) });
		const stop = scheduleAgentPruning(db, 30 * DAY, 1000);
		expect(db.select().from(surveys).all()).toHaveLength(0);

		ask({ age: 1 }, {}, { now: ago(40) });
		vi.advanceTimersByTime(1000);
		expect(db.select().from(surveys).all()).toHaveLength(0);

		stop();
		ask({ age: 1 }, {}, { now: ago(40) });
		vi.advanceTimersByTime(5000);
		expect(db.select().from(surveys).all()).toHaveLength(1);
	});
});

describe('validation', () => {
	const code = (input: Parameters<typeof survey>[2]) => {
		try {
			survey(db, actor, input, { now: NOW });
		} catch (error) {
			return (error as { code?: string }).code;
		}
		return 'ok';
	};

	it('refuses out-of-range and malformed requests as invalid', () => {
		labour();
		const w = { age: 1 };
		expect(code({ weights: {} })).toBe('invalid');
		expect(code({ weights: { age: 11 } })).toBe('invalid');
		expect(code({ weights: { age: Infinity } })).toBe('invalid');
		expect(code({ weights: { Age: 1 } })).toBe('invalid');
		expect(
			code({ weights: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])) })
		).toBe('invalid');
		expect(code({ weights: w, temperature: 2.1 })).toBe('invalid');
		expect(code({ weights: w, limit: 0 })).toBe('invalid');
		expect(code({ weights: w, limit: 51 })).toBe('invalid');
		expect(code({ weights: w, limit: 1.5 })).toBe('invalid');
		expect(code({ weights: w, query: 'x'.repeat(501) })).toBe('invalid');
		expect(code({ weights: w, show: Array.from({ length: 17 }, (_, i) => `k${i}`) })).toBe(
			'invalid'
		);
		expect(code({ weights: w, show: ['Bad'] })).toBe('invalid');
		expect(code({ weights: w, realmIds: [] })).toBe('invalid');
		expect(code({ weights: w, filter: { assigneeIds: [] } })).toBe('invalid');
		expect(code({ weights: w, filter: { has: ['plain'] } })).toBe('invalid');
		expect(code({ weights: w, filter: { includeClosed: { withinDays: 0 } } })).toBe('invalid');
		expect(code({ weights: w, filter: { includeClosed: { withinDays: 3651 } } })).toBe('invalid');
		expect(code({ weights: w, query: '   ' })).toBe('ok');
		expect(code({ weights: { age: -10, 'a-b_c:d-e': 10 } })).toBe('ok');
	});

	it('refuses lists past their caps as invalid', () => {
		labour();
		const w = { age: 1 };
		const many = <T>(size: number, item: (i: number) => T) =>
			Array.from({ length: size }, (_, i) => item(i));
		expect(code({ weights: w, realmIds: many(65, (i) => i + 1) })).toBe('invalid');
		expect(code({ weights: w, filter: { assigneeIds: many(65, (i) => i + 1) } })).toBe('invalid');
		expect(code({ weights: w, filter: { has: many(33, (i) => `topic:m${i}`) } })).toBe('invalid');
		expect(code({ weights: w, filter: { labels: many(21, (i) => `l${i}`) } })).toBe('invalid');
	});

	it('runs every list at its cap without an internal error', () => {
		labour();
		const realms = [realmId, ...Array.from({ length: 63 }, (_, i) => seedRealm(db, `X${i}`).id)];
		const users = Array.from({ length: 64 }, (_, i) => seedUser(db, `cap${i}`));
		expect(
			code({
				weights: { age: 1 },
				realmIds: realms,
				filter: {
					assigneeIds: [null, ...users.slice(1)],
					has: Array.from({ length: 32 }, (_, i) => `topic:m${i}`),
					labels: Array.from({ length: 20 }, (_, i) => `l${i}`)
				}
			})
		).toBe('ok');
		expect(code({ weights: { age: 1 }, realmIds: realms.map((id) => id + 1000) })).toBe(
			'not_found'
		);
	});

	it('refuses unknown Realm, User and Quest ids as not_found', () => {
		const w = { age: 1 };
		expect(code({ weights: w, realmIds: [999] })).toBe('not_found');
		expect(code({ weights: w, forUserId: 999 })).toBe('not_found');
		expect(code({ weights: w, filter: { assigneeIds: [999] } })).toBe('not_found');
		expect(code({ weights: w, filter: { questId: 999 } })).toBe('not_found');
	});

	it('treats an empty query as absent so keywords is ignored', () => {
		labour();
		expect(ask({ keywords: 1 }, { query: '  ' }).ignored).toEqual(['keywords']);
	});
});

describe('performance', () => {
	const ADD_EVERY = 500;
	const WEIGHTS = {
		keywords: 2,
		mentions: 1,
		pulled_in: 1,
		evidence: 1,
		unblocks: 1,
		quest_finish: 1,
		column: 1,
		age: 0.5,
		activity: 1,
		sentiment: 1,
		pain: 1,
		delight: 1,
		skill_fit: 1,
		affinity: 1,
		impact: 3,
		'topic:boss': 2
	};

	function insertAll<T>(rows: T[], insert: (part: T[]) => void) {
		for (let at = 0; at < rows.length; at += ADD_EVERY) insert(rows.slice(at, at + ADD_EVERY));
	}

	// `n` Labours spread over the Realms in turn, two columns each, with Attribute values, Links,
	// Quests of 100 Labours, Comments, Mentions, Appraisals and needed Skills on them, and Skills held
	// by the workers.
	function seedBench(perf: Db, keys: string[], n: number) {
		const admin = seedActor(perf);
		const realmIds = keys.map((key) => seedRealm(perf, key).id);
		const stateIds = realmIds.map((id) => {
			const doing = createState(perf, admin, id, {
				key: 'doing',
				label: 'Doing',
				color: '#222222',
				icon: 'circle'
			});
			const todo = perf
				.select()
				.from(states)
				.where(and(eq(states.realmId, id), eq(states.key, 'todo')))
				.get()!;
			return [todo.id, doing.id];
		});
		const workers = Array.from({ length: 10 }, (_, i) => seedUser(perf, `worker${i}`));
		const attributeIds = realmIds.map((id) => {
			const impact = defineAttribute(perf, admin, id, {
				key: 'impact',
				kind: 'scale',
				label: 'I',
				rubric: 'x',
				spec: { min: 0, max: 10 }
			}).attribute;
			const topic = defineAttribute(perf, admin, id, {
				key: 'topic',
				kind: 'tags',
				label: 'T',
				rubric: 'x',
				spec: {
					members: [
						{ key: 'ui', label: 'UI' },
						{ key: 'audio', label: 'Audio' },
						{ key: 'boss', label: 'Boss' }
					]
				}
			}).attribute;
			return { impact: impact.id, topic: topic.id };
		});

		const skillIds = ['vfx', 'audio', 'design'].map(
			(key) => defineSkill(perf, admin, { key, label: key }).id
		);

		const perRealm = Math.ceil(n / keys.length);
		const counter = keys.map(() => 0);
		const rows: (typeof labours.$inferInsert)[] = [];
		const columns = new Map<number, number>();
		for (let i = 0; i < n; i += 1) {
			const r = i % keys.length;
			const s = Math.floor(counter[r] / (perRealm / 2)) % 2;
			counter[r] += 1;
			const stateId = stateIds[r][s];
			columns.set(stateId, (columns.get(stateId) ?? 0) + 1);
			rows.push({
				id: i + 1,
				realmId: realmIds[r],
				number: counter[r],
				title: `Boss fight task ${i} ${i % 7 === 0 ? 'telegraph' : 'cleanup'}`,
				description: `Details for ${i}. See ${keys[(i * 3) % keys.length]}-${((i * 7) % 1000) + 1} and @worker${i % 10}.`,
				ownerId: workers[i % 10],
				assigneeId: i % 3 === 0 ? workers[i % 10] : null,
				stateId,
				rank: '',
				labels: i % 5 === 0 ? ['bug'] : [],
				createdAt: ago(i % 120),
				updatedAt: ago(i % 30)
			});
		}
		const ranks = new Map(
			[...columns].map(([stateId, size]) => [stateId, generateNKeysBetween(null, null, size)])
		);
		const used = new Map<number, number>();
		for (const row of rows) {
			const at = used.get(row.stateId) ?? 0;
			used.set(row.stateId, at + 1);
			row.rank = ranks.get(row.stateId)![at];
		}
		const realmKey = new Map(realmIds.map((id, r) => [id, keys[r]]));

		const questIds: number[] = [];
		perf.transaction((tx) => {
			insertAll(rows, (part) => tx.insert(labours).values(part).run());
			insertAll(
				rows.map((row) => ({
					key: `${realmKey.get(row.realmId)}-${row.number}`,
					labourId: row.id!
				})),
				(part) => tx.insert(labourKeys).values(part).run()
			);

			const held: (typeof labourAttributes.$inferInsert)[] = [];
			for (const row of rows) {
				const ids = attributeIds[realmIds.indexOf(row.realmId)];
				const base = { realmId: row.realmId, labourId: row.id!, setBy: admin.id, setAt: NOW };
				if (row.id! % 4 !== 0) held.push({ ...base, attributeId: ids.impact, value: row.id! % 11 });
				if (row.id! % 3 !== 0) {
					const value = row.id! % 2 === 0 ? ['audio', 'boss'] : ['ui'];
					held.push({ ...base, attributeId: ids.topic, value });
				}
			}
			insertAll(held, (part) => tx.insert(labourAttributes).values(part).run());

			insertAll(
				workers.flatMap((userId, w) =>
					skillIds.slice(0, 1 + (w % 3)).map((skillId, s) => ({
						userId,
						skillId,
						level: 1 + ((w + s) % 5),
						setBy: admin.id,
						setAt: NOW
					}))
				),
				(part) => tx.insert(userSkills).values(part).run()
			);
			const needed: (typeof labourNeeds.$inferInsert)[] = [];
			for (const row of rows) {
				if (row.id! % 3 === 0) continue;
				const wanted = skillIds.slice(0, 1 + (row.id! % 3));
				for (const skillId of wanted) {
					needed.push({
						labourId: row.id!,
						skillId,
						level: 1 + ((row.id! + skillId) % 5),
						setBy: admin.id,
						setAt: NOW
					});
				}
			}
			insertAll(needed, (part) => tx.insert(labourNeeds).values(part).run());

			const reports: (typeof pulses.$inferInsert)[] = [];
			realmIds.forEach((realmId, r) => {
				const ids = attributeIds[r];
				const keys = [
					{ attributeId: ids.impact, member: null, rawKey: 'impact' },
					{ attributeId: ids.topic, member: 'ui', rawKey: 'topic:ui' },
					{ attributeId: ids.topic, member: 'boss', rawKey: 'topic:boss' },
					{ attributeId: null, member: null, rawKey: 'unheard' }
				];
				const moods = [0.5, -0.6, 0.4, 0];
				for (let i = 0; i < 400; i += 1) {
					const key = keys[i % keys.length];
					reports.push({
						realmId,
						...key,
						amount: 1 + (i % 5),
						mood: moods[i % keys.length] * (0.5 + (i % 3) / 3),
						halfLifeDays: i % 7 === 0 ? null : 14,
						note: `Report ${i}`,
						authorId: admin.id,
						createdAt: ago(i % 60)
					});
				}
			});
			insertAll(reports, (part) => tx.insert(pulses).values(part).run());

			const habits: (typeof pulses.$inferInsert)[] = [];
			realmIds.forEach((_, r) => {
				const ids = attributeIds[r];
				const keys = [
					{ attributeId: ids.impact, member: null, rawKey: 'impact', mood: 0.6 },
					{ attributeId: ids.topic, member: 'ui', rawKey: 'topic:ui', mood: 0.5 },
					{ attributeId: ids.topic, member: 'boss', rawKey: 'topic:boss', mood: -0.4 }
				];
				for (let i = 0; i < 60; i += 1) {
					habits.push({
						userId: workers[0],
						...keys[i % keys.length],
						amount: 0.5 + (i % 4) / 2,
						halfLifeDays: 30,
						note: `Habit ${i}`,
						authorId: admin.id,
						createdAt: ago(i % 45)
					});
				}
			});
			insertAll(habits, (part) => tx.insert(pulses).values(part).run());

			const edges = new Map<string, typeof links.$inferInsert>();
			for (let from = 1; from <= Math.floor(n * 0.6); from += 1) {
				const to = from + 1 + ((from * 13) % 50);
				const type = from % 2 === 0 ? 'evidence' : 'blocks';
				if (to <= n)
					edges.set(`${from}:${to}:${type}`, {
						fromId: from,
						toId: to,
						type,
						setBy: admin.id,
						setAt: NOW
					});
			}
			insertAll([...edges.values()], (part) => tx.insert(links).values(part).run());

			const members: (typeof questLabours.$inferInsert)[] = [];
			for (let q = 0; q < n / 200; q += 1) {
				const questId = tx
					.insert(quests)
					.values({ name: `Q${q}`, ownerId: admin.id })
					.returning()
					.get().id;
				questIds.push(questId);
				const rankList = generateNKeysBetween(null, null, 100);
				for (let m = 0; m < 100; m += 1)
					members.push({ questId, labourId: ((q * 97 + m * 31) % n) + 1, rank: rankList[m] });
			}
			insertAll(members, (part) => tx.insert(questLabours).values(part).run());

			const notes: (typeof comments.$inferInsert)[] = [];
			for (let i = 0; i < n * 0.8; i += 1) {
				notes.push({
					labourId: ((i * 17) % n) + 1,
					authorId: workers[i % 10],
					body: `Comment ${i} about boss telegraph and ${keys[i % keys.length]}-${(i % 500) + 1}`,
					createdAt: ago(i % 90)
				});
			}
			insertAll(notes, (part) => tx.insert(comments).values(part).run());

			const briefs: (typeof appraisals.$inferInsert)[] = [];
			for (let i = 1; i <= n; i += 2) {
				briefs.push({
					labourId: i,
					brief: `Brief ${i}`,
					...(i % 3 === 0
						? { contentHash: 'a'.repeat(64), appraisedBy: admin.id, appraisedAt: NOW }
						: {})
				});
			}
			insertAll(briefs, (part) => tx.insert(appraisals).values(part).run());
		});
		rebuildDerived(perf);
		return { admin, realmIds, workers, questIds };
	}

	type Bench = ReturnType<typeof seedBench>;

	const everything = (bench: Bench, more: Partial<Parameters<typeof survey>[2]> = {}) => ({
		query: 'boss telegraph',
		forUserId: bench.workers[0],
		weights: WEIGHTS,
		temperature: 0.3,
		show: ['impact', 'topic'],
		...more
	});

	// Each weight alone puts a candidate that scores above 0 on top, so no loader came back empty.
	function expectEveryFeature(perf: Db, bench: Bench, more: Partial<Parameters<typeof survey>[2]>) {
		for (const key of Object.keys(WEIGHTS)) {
			const { results } = survey(
				perf,
				bench.admin,
				{ ...everything(bench, more), weights: { [key]: 1 }, temperature: 0, limit: 1 },
				{ now: NOW }
			);
			expect(results[0].contributions[key] ?? 0, key).toBeGreaterThan(0);
		}
	}

	function medianMs(label: string, run: () => void): number {
		run();
		const times = [0, 1, 2].map(() => {
			const start = performance.now();
			run();
			return performance.now() - start;
		});
		times.sort((a, b) => a - b);
		console.info(`${label}: ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
		return times[1];
	}

	it('scores 5,000 Labours with every feature in under 200 ms', { timeout: 120_000 }, () => {
		const perf = testDb();
		try {
			const bench = seedBench(perf, ['PA', 'PB', 'PC'], 5000);
			const run = () => survey(perf, bench.admin, everything(bench), { now: NOW });
			const first = run();
			expect(first.coverage.candidates).toBe(5000);
			expect(first.coverage.stale).toBeGreaterThan(0);
			expect(first.results).toHaveLength(15);
			expectEveryFeature(perf, bench, {});
			expect(medianMs('survey at 5,000', run)).toBeLessThan(200);
		} finally {
			perf.$client.close();
		}
	});

	it(
		'scores the Sentiment features at 5,000 Labours holding a 64-member tags Attribute in under 200 ms',
		{ timeout: 120_000 },
		() => {
			const perf = testDb();
			try {
				const bench = seedBench(perf, ['PA', 'PB', 'PC'], 5000);
				const members = Array.from({ length: 64 }, (_, i) => ({
					key: `m${i}`,
					label: `M${i}`,
					rubric: 'r'.repeat(1000)
				}));
				const fat = new Map(
					bench.realmIds.map((id) => [
						id,
						defineAttribute(perf, bench.admin, id, {
							key: 'fat',
							kind: 'tags',
							label: 'F',
							rubric: 'x',
							spec: { members }
						}).attribute.id
					])
				);
				const everyone = perf
					.select({ id: labours.id, realmId: labours.realmId })
					.from(labours)
					.all();
				insertAll(
					everyone.map((row) => ({
						realmId: row.realmId,
						labourId: row.id,
						attributeId: fat.get(row.realmId)!,
						value: ['m0', 'm1'],
						setBy: bench.admin.id,
						setAt: NOW
					})),
					(part) => perf.insert(labourAttributes).values(part).run()
				);
				const run = () =>
					survey(
						perf,
						bench.admin,
						{ weights: { sentiment: 1, pain: 1, delight: 1 }, temperature: 0 },
						{ now: NOW }
					);
				expect(run().coverage.candidates).toBe(5000);
				expect(medianMs('sentiment features over fat tags at 5,000', run)).toBeLessThan(200);
			} finally {
				perf.$client.close();
			}
		}
	);

	it(
		'costs by the candidates, not the database: 5,000 and 100 of 40,000 Labours',
		{ timeout: 300_000 },
		() => {
			const perf = testDb();
			try {
				const bench = seedBench(perf, ['PA', 'PB', 'PC', 'PD', 'PE', 'PF', 'PG', 'PH'], 40_000);
				const oneRealm = { realmIds: [bench.realmIds[0]] };
				const oneQuest = { filter: { questId: bench.questIds[0] } };
				const run = (more: Partial<Parameters<typeof survey>[2]>) => () =>
					survey(perf, bench.admin, everything(bench, more), { now: NOW });

				expect(run(oneRealm)().coverage.candidates).toBe(5000);
				expectEveryFeature(perf, bench, oneRealm);
				expect(medianMs('survey at 5,000 of 40,000', run(oneRealm))).toBeLessThan(200);

				expect(run(oneQuest)().coverage.candidates).toBe(100);
				expectEveryFeature(perf, bench, oneQuest);
				expect(medianMs('survey at 100 of 40,000', run(oneQuest))).toBeLessThan(50);
			} finally {
				perf.$client.close();
			}
		}
	);
});
