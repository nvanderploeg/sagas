import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { defineAttribute, setValues } from '#lib/server/agent/attributes.ts';
import { contentHash } from '#lib/server/agent/content.ts';
import { pruneSurveys, survey, type SurveyInput } from '#lib/server/agent/survey/index.ts';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours, surveys } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { createQuest, addQuestLabours } from '#lib/server/domain/quests.ts';
import { createState, listStates } from '#lib/server/domain/states.ts';
import { moveLabour, rankLabour, updateLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	db.$client.close();
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

// Every Labour scores 0 on it while no Links exist, so the order is the board order.
const NEUTRAL = { evidence: 1 };

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

function run(input: Partial<SurveyInput> = {}, opts: { now?: Date; random?: () => number } = {}) {
	return survey(db, actor, { weights: NEUTRAL, temperature: 0, ...input }, { now: NOW, ...opts });
}

const ids = (result: { results: { labourId: number }[] }) => result.results.map((r) => r.labourId);
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as any;
const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
const closedOf = (realmId: number) => listStates(db, realmId).find((s) => s.isClosed)!;

function close(labour: { id: number; realmId: number }) {
	updateLabour(db, actor, labour.id, { stateId: closedOf(labour.realmId).id });
}

function touch(id: number, patch: { createdAt?: Date; updatedAt?: Date }) {
	db.update(labours).set(patch).where(eq(labours.id, id)).run();
}

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

function text(realmId: number, key: string) {
	defineAttribute(db, actor, realmId, { key, kind: 'text', label: key, rubric: 'rubric' });
}

const set = (labourId: number, values: Record<string, unknown>) =>
	setValues(db, actor, labourId, values);

function link(from: number, type: 'evidence' | 'blocks', to: number) {
	appraise(db, actor, [{ labourId: from, links: [{ type, to }] }]);
}

function sampler(draws: number[]) {
	let next = 0;
	const random = () => draws[next++];
	return { random, drawn: () => next };
}

// The contract's order for Scores `scores` (board order) and draws `draws`.
function noisyOrder(scores: number[], temperature: number, draws: number[]): number[] {
	const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
	const sigma =
		scores.length < 2
			? 0
			: Math.sqrt(scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length);
	const noisy = scores.map((score, i) => {
		const u = Math.min(Math.max(draws[i], 1e-12), 1 - 1e-12);
		return score + temperature * sigma * -Math.log(-Math.log(u));
	});
	return scores.map((_, i) => i).sort((a, b) => noisy[b] - noisy[a] || a - b);
}

// Four Labours in board order whose Scores under { impact: 1 } are 1, 0.75, 0.5, 0.25.
function ratedFour() {
	const realm = seedRealm(db, 'AM');
	scale(realm.id, 'impact', 0, 4);
	const rated = [4, 3, 2, 1].map((value) => {
		const labour = seedLabour(db, { realmId: realm.id });
		set(labour.id, { impact: value });
		return labour;
	});
	return { realm, rated, scores: [1, 0.75, 0.5, 0.25] };
}

describe('validation', () => {
	function expectInvalid(input: Partial<SurveyInput>) {
		seedRealm(db, 'AM');
		expectDomainError(() => run(input), 'invalid');
		expect(db.select().from(surveys).all()).toHaveLength(0);
	}

	const manyWeights = (count: number) =>
		Object.fromEntries(Array.from({ length: count }, (_, i) => [`w${i}`, 1]));

	it.each([
		['no weights', {}],
		['65 weights', manyWeights(65)],
		['a weight above 10', { age: 10.001 }],
		['a weight below -10', { age: -10.001 }],
		['a NaN weight', { age: NaN }],
		['an infinite weight', { age: Infinity }],
		['a negative infinite weight', { age: -Infinity }],
		['an uppercase key', { Age: 1 }],
		['a key starting with a digit', { '1age': 1 }],
		['an empty key', { '': 1 }],
		['two colons', { 'a:b:c': 1 }],
		['a 33-character key', { ['a'.repeat(33)]: 1 }],
		['a 33-character member', { ['a:' + 'b'.repeat(33)]: 1 }],
		['an empty member', { 'attr:': 1 }],
		['an underscore in a member', { 'attr:a_b': 1 }],
		['a space in a key', { 'a b': 1 }]
	])('refuses weights with %s', (_name, weights) => {
		expectInvalid({ weights });
	});

	it.each([
		['no Realm ids', { realmIds: [] }],
		['a 501-character query', { query: 'a'.repeat(501) }],
		['a negative temperature', { temperature: -0.1 }],
		['a temperature above 2', { temperature: 2.1 }],
		['a NaN temperature', { temperature: NaN }],
		['a limit of 0', { limit: 0 }],
		['a limit of 51', { limit: 51 }],
		['a fractional limit', { limit: 1.5 }],
		['a NaN limit', { limit: NaN }],
		['17 show keys', { show: Array.from({ length: 17 }, (_, i) => `a${i}`) }],
		['an uppercase show key', { show: ['Impact'] }],
		['a show key with a member', { show: ['area:ui'] }],
		['a bare has key', { filter: { has: ['area'] } }],
		['a has key with two colons', { filter: { has: ['a:b:c'] } }],
		['an uppercase has key', { filter: { has: ['Area:ui'] } }],
		['a has key with an empty member', { filter: { has: ['area:'] } }],
		['no assignees', { filter: { assigneeIds: [] } }],
		['withinDays of 0', { filter: { includeClosed: { withinDays: 0 } } }],
		['negative withinDays', { filter: { includeClosed: { withinDays: -1 } } }],
		['withinDays above 3650', { filter: { includeClosed: { withinDays: 3651 } } }],
		['NaN withinDays', { filter: { includeClosed: { withinDays: NaN } } }]
	] as [string, Partial<SurveyInput>][])('refuses %s', (_name, input) => {
		expectInvalid(input);
	});

	it('accepts every limit at its edge', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		const edges: Partial<SurveyInput>[] = [
			{ weights: manyWeights(64) },
			{ weights: { age: 10 } },
			{ weights: { age: -10 } },
			{ weights: { ['a'.repeat(32)]: 1 } },
			{ weights: { ['a'.repeat(32) + ':' + 'b'.repeat(32)]: 1 } },
			{ weights: { 'my-attr_1:my-member-2': 1 } },
			{ temperature: 0 },
			{ temperature: 2 },
			{ limit: 1 },
			{ limit: 50 },
			{ query: 'a'.repeat(500) },
			{ query: `  ${'a'.repeat(500)}  ` },
			{ show: Array.from({ length: 16 }, (_, i) => `a${i}`) },
			{ show: [] },
			{ filter: { includeClosed: { withinDays: 3650 } } },
			{ filter: { includeClosed: { withinDays: 0.5 } } },
			{ filter: { includeClosed: true, has: [], labels: [] } }
		];

		for (const edge of edges) {
			expect(run(edge).coverage.candidates, JSON.stringify(edge).slice(0, 80)).toBe(1);
		}
	});

	it('answers not_found for an unknown Realm, User or Quest', () => {
		const realm = seedRealm(db, 'AM');

		expectDomainError(() => run({ realmIds: [9999] }), 'not_found');
		expectDomainError(() => run({ realmIds: [realm.id, 9999] }), 'not_found');
		expectDomainError(() => run({ forUserId: 9999 }), 'not_found');
		expectDomainError(() => run({ filter: { questId: 9999 } }), 'not_found');
		expect(db.select().from(surveys).all()).toHaveLength(0);
	});
});

describe('candidates', () => {
	it('is every open Labour of every Realm by default, closed ones left out', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		const shut = seedLabour(db, { realmId: am.id });
		close(shut);

		const result = run();

		expect(ids(result)).toEqual([a.id, b.id]);
		expect(result.coverage.candidates).toBe(2);
	});

	it('limits to the named Realms', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const cx = seedRealm(db, 'CX');
		seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		const c = seedLabour(db, { realmId: cx.id });

		expect(ids(run({ realmIds: [bl.id] }))).toEqual([b.id]);
		expect(ids(run({ realmIds: [cx.id, bl.id] }))).toEqual([b.id, c.id]);
	});

	it('orders by Realm id, then State position, then Rank', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const doing = createState(db, actor, am.id, style('doing'));
		const b1 = seedLabour(db, { realmId: bl.id });
		const a1 = seedLabour(db, { realmId: am.id, stateId: doing.id });
		const a2 = seedLabour(db, { realmId: am.id });
		const a3 = seedLabour(db, { realmId: am.id });
		const a4 = seedLabour(db, { realmId: am.id });
		close(a4);
		rankLabour(db, actor, a3.id, 'top');

		expect(ids(run())).toEqual([a3.id, a2.id, a1.id, b1.id]);
		expect(ids(run({ filter: { includeClosed: true } }))).toEqual([
			a3.id,
			a2.id,
			a1.id,
			a4.id,
			b1.id
		]);
	});

	it('adds every Closed Labour for includeClosed: true', () => {
		const realm = seedRealm(db, 'AM');
		const open = seedLabour(db, { realmId: realm.id });
		const old = seedLabour(db, { realmId: realm.id });
		close(old);
		touch(old.id, { updatedAt: daysAgo(3000) });

		const result = run({ filter: { includeClosed: true } });

		expect(ids(result)).toEqual([open.id, old.id]);
		expect(result.coverage.candidates).toBe(2);
	});

	it('adds Closed Labours updated within withinDays days of now, the edge included', () => {
		const realm = seedRealm(db, 'AM');
		const open = seedLabour(db, { realmId: realm.id });
		const fresh = seedLabour(db, { realmId: realm.id });
		const edge = seedLabour(db, { realmId: realm.id });
		const stale = seedLabour(db, { realmId: realm.id });
		for (const labour of [fresh, edge, stale]) close(labour);
		touch(fresh.id, { updatedAt: daysAgo(1) });
		touch(edge.id, { updatedAt: daysAgo(3) });
		touch(stale.id, { updatedAt: new Date(daysAgo(3).getTime() - 1) });

		const result = run({ filter: { includeClosed: { withinDays: 3 } } });

		expect(ids(result)).toEqual([open.id, fresh.id, edge.id]);
	});

	it('filters by Assignee, null meaning unassigned', () => {
		const realm = seedRealm(db, 'AM');
		const bob = seedUser(db, 'bob');
		const carol = seedUser(db, 'carol');
		const none = seedLabour(db, { realmId: realm.id });
		const ofBob = seedLabour(db, { realmId: realm.id, assigneeId: bob });
		const ofCarol = seedLabour(db, { realmId: realm.id, assigneeId: carol });

		expect(ids(run({ filter: { assigneeIds: [bob] } }))).toEqual([ofBob.id]);
		expect(ids(run({ filter: { assigneeIds: [null] } }))).toEqual([none.id]);
		expect(ids(run({ filter: { assigneeIds: [null, carol] } }))).toEqual([none.id, ofCarol.id]);
		expect(ids(run({ filter: { assigneeIds: [bob, carol] } }))).toEqual([ofBob.id, ofCarol.id]);
	});

	it('filters by Labels, keeping Labours that carry every one, normalized as Labels are', () => {
		const realm = seedRealm(db, 'AM');
		const both = seedLabour(db, { realmId: realm.id, labels: ['bug', 'ui'] });
		const one = seedLabour(db, { realmId: realm.id, labels: ['bug'] });
		seedLabour(db, { realmId: realm.id });

		expect(ids(run({ filter: { labels: ['bug'] } }))).toEqual([both.id, one.id]);
		expect(ids(run({ filter: { labels: ['bug', 'ui'] } }))).toEqual([both.id]);
		expect(ids(run({ filter: { labels: [' BUG ', 'Ui'] } }))).toEqual([both.id]);
		expect(ids(run({ filter: { labels: ['bug', 'nope'] } }))).toEqual([]);
	});

	it('filters by Quest, in board order rather than Quest order', () => {
		const realm = seedRealm(db, 'AM');
		const first = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id });
		const second = seedLabour(db, { realmId: realm.id });
		const gone = seedLabour(db, { realmId: realm.id });
		close(gone);
		const quest = createQuest(db, actor, { name: 'Q', ownerId: actor.id });
		addQuestLabours(db, actor, quest.id, [gone.id, second.id, first.id]);

		expect(ids(run({ filter: { questId: quest.id } }))).toEqual([first.id, second.id]);
		expect(ids(run({ filter: { questId: quest.id, includeClosed: true } }))).toEqual([
			first.id,
			second.id,
			gone.id
		]);
	});

	it('filters by held tags members, all of them, and a Realm lacking the Attribute holds none', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		tags(am.id, 'area', ['ui', 'api', 'ux']);
		const both = seedLabour(db, { realmId: am.id });
		const ui = seedLabour(db, { realmId: am.id });
		seedLabour(db, { realmId: am.id });
		seedLabour(db, { realmId: bl.id });
		set(both.id, { area: ['ui', 'api'] });
		set(ui.id, { area: ['ui'] });

		expect(ids(run({ filter: { has: ['area:ui'] } }))).toEqual([both.id, ui.id]);
		expect(ids(run({ filter: { has: ['area:ui', 'area:api'] } }))).toEqual([both.id]);
		expect(ids(run({ filter: { has: ['area:ux'] } }))).toEqual([]);
		expect(ids(run({ filter: { has: ['ghost:x'] } }))).toEqual([]);
		expect(run({ filter: { has: ['area:ux'] } }).coverage.candidates).toBe(0);
	});

	it('drops, for unblocked, every Labour some open Labour blocks, whatever Realm the blocker is in', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const free = seedLabour(db, { realmId: am.id });
		const blocked = seedLabour(db, { realmId: am.id });
		const reopened = seedLabour(db, { realmId: am.id });
		const blocker = seedLabour(db, { realmId: bl.id });
		const doneBlocker = seedLabour(db, { realmId: bl.id });
		close(doneBlocker);
		link(blocker.id, 'blocks', blocked.id);
		link(doneBlocker.id, 'blocks', reopened.id);

		expect(ids(run({ realmIds: [am.id], filter: { unblocked: true } }))).toEqual([
			free.id,
			reopened.id
		]);
		expect(ids(run({ realmIds: [am.id], filter: { unblocked: false } }))).toEqual([
			free.id,
			blocked.id,
			reopened.id
		]);
		expect(ids(run({ realmIds: [am.id] }))).toEqual([free.id, blocked.id, reopened.id]);
	});

	it('drops every Labour down a chain of blocks, not only the first', () => {
		const realm = seedRealm(db, 'AM');
		const head = seedLabour(db, { realmId: realm.id });
		const middle = seedLabour(db, { realmId: realm.id });
		const tail = seedLabour(db, { realmId: realm.id });
		link(head.id, 'blocks', middle.id);
		link(middle.id, 'blocks', tail.id);

		expect(ids(run({ filter: { unblocked: true } }))).toEqual([head.id]);
	});

	it('applies every filter together', () => {
		const realm = seedRealm(db, 'AM');
		const bob = seedUser(db, 'bob');
		const hit = seedLabour(db, { realmId: realm.id, assigneeId: bob, labels: ['bug'] });
		seedLabour(db, { realmId: realm.id, assigneeId: bob });
		seedLabour(db, { realmId: realm.id, labels: ['bug'] });

		const result = run({ filter: { assigneeIds: [bob], labels: ['bug'] } });

		expect(ids(result)).toEqual([hit.id]);
		expect(result.coverage.candidates).toBe(1);
	});

	it('counts every candidate in coverage before limit cuts the results', () => {
		const realm = seedRealm(db, 'AM');
		const made = Array.from({ length: 4 }, () => seedLabour(db, { realmId: realm.id }));

		const result = run({ limit: 2 });

		expect(ids(result)).toEqual([made[0].id, made[1].id]);
		expect(result.coverage.candidates).toBe(4);
	});

	it('returns nothing, without error, when no Labour passes', () => {
		seedRealm(db, 'AM');

		const result = run();

		expect(result.results).toEqual([]);
		expect(result.coverage).toEqual({
			candidates: 0,
			unappraised: 0,
			stale: 0,
			unembedded: 0,
			missing: {}
		});
		expect(db.select().from(surveys).all()).toHaveLength(1);
	});
});

describe('weight keys', () => {
	function fixture() {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		scale(am.id, 'impact', 1, 5);
		tags(am.id, 'area', ['ui', 'api']);
		text(am.id, 'notes');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		return { am, bl, a, b };
	}

	it('applies built-in names and Attribute keys, ignoring none of them', () => {
		fixture();

		const result = run({
			query: 'x',
			weights: {
				keywords: 1,
				mentions: 1,
				pulled_in: 1,
				evidence: 1,
				unblocks: 1,
				quest_finish: 1,
				column: 1,
				age: 1,
				activity: 1,
				impact: 1,
				'area:ui': 1
			}
		});

		expect(result.ignored).toEqual([]);
	});

	it.each(['similarity', 'affinity', 'rank', 'priority'])(
		'ignores %s, which is recognised but not computed',
		(key) => {
			fixture();

			const result = run({ weights: { [key]: 5 } });

			expect(result.ignored).toEqual([key]);
			expect(result.results[0].score).toBe(0);
			expect(result.results[0].contributions).toEqual({});
		}
	);

	it('ignores keywords without a query, or with a blank one', () => {
		fixture();

		expect(run({ weights: { keywords: 1 } }).ignored).toEqual(['keywords']);
		expect(run({ weights: { keywords: 1 }, query: '' }).ignored).toEqual(['keywords']);
		expect(run({ weights: { keywords: 1 }, query: '   ' }).ignored).toEqual(['keywords']);
		expect(run({ weights: { keywords: 1 }, query: 'boss' }).ignored).toEqual([]);
	});

	it('applies a bare scale Attribute only when a surveyed Realm has it', () => {
		const { am, bl } = fixture();

		expect(run({ realmIds: [am.id], weights: { impact: 1 } }).ignored).toEqual([]);
		expect(run({ realmIds: [bl.id], weights: { impact: 1 } }).ignored).toEqual(['impact']);
		expect(run({ realmIds: [bl.id, am.id], weights: { impact: 1 } }).ignored).toEqual([]);
	});

	it('applies attr:member only for a tags Attribute with that member in a surveyed Realm', () => {
		const { am, bl } = fixture();

		expect(run({ realmIds: [am.id], weights: { 'area:ui': 1 } }).ignored).toEqual([]);
		expect(run({ realmIds: [bl.id], weights: { 'area:ui': 1 } }).ignored).toEqual(['area:ui']);
		expect(run({ weights: { 'area:nope': 1 } }).ignored).toEqual(['area:nope']);
	});

	it('ignores a bare tags or text key, a member on a scale or text key, and unknown keys', () => {
		fixture();

		const result = run({
			weights: { area: 1, notes: 1, 'impact:high': 1, 'notes:x': 1, ghost: 1, 'ghost:x': 1 }
		});

		expect(result.ignored).toEqual(['area', 'notes', 'impact:high', 'notes:x', 'ghost', 'ghost:x']);
		expect(result.results.map((r) => r.score)).toEqual([0, 0]);
		expect(result.coverage.missing).toEqual({});
	});

	it('lists each ignored key once, weights first and then show, in the order given', () => {
		fixture();

		const result = run({
			weights: { zeta: 1, age: 1, similarity: 1, alpha: 1 },
			show: ['ghost', 'impact', 'zeta']
		});

		expect(result.ignored).toEqual(['zeta', 'similarity', 'alpha', 'ghost']);
	});

	it('does not let an ignored key change a Score', () => {
		const { a } = fixture();
		set(a.id, { impact: 5 });

		const plain = run({ weights: { impact: 1 } });
		const noisy = run({ weights: { impact: 1, ghost: 9, similarity: -9 } });

		expect(noisy.results.map((r) => r.score)).toEqual(plain.results.map((r) => r.score));
		expect(noisy.coverage.missing).toEqual(plain.coverage.missing);
	});
});

describe('missing data', () => {
	function fixture() {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		scale(am.id, 'impact', 1, 5);
		tags(am.id, 'area', ['ui', 'api']);
		const set5 = seedLabour(db, { realmId: am.id });
		const unset = seedLabour(db, { realmId: am.id });
		const other = seedLabour(db, { realmId: bl.id });
		set(set5.id, { impact: 5, area: ['api'] });
		return { am, bl, set5, unset, other };
	}

	it('gives 0.5 to a Labour with an unset value or whose Realm lacks the Attribute', () => {
		const { set5, unset, other } = fixture();

		const result = run({ weights: { impact: 2 } });

		const score = (id: number) => result.results.find((r) => r.labourId === id)!.score;
		expect(score(set5.id)).toBeCloseTo(2, 10);
		expect(score(unset.id)).toBeCloseTo(1, 10);
		expect(score(other.id)).toBeCloseTo(1, 10);
		expect(result.coverage.missing).toEqual({ impact: 2 });
	});

	it('counts missing per key, only for keys above zero', () => {
		const { unset } = fixture();
		set(unset.id, { impact: 1 });

		const result = run({ weights: { impact: 1, 'area:ui': 1, age: 1 } });

		expect(result.coverage.missing).toEqual({ impact: 1, 'area:ui': 2 });
	});

	it('is empty when nothing is missing', () => {
		fixture();

		expect(run({ weights: { age: 1, column: 1 } }).coverage.missing).toEqual({});
	});

	it('scores a held tags Attribute lacking the member 0, not missing', () => {
		const { set5, unset, other } = fixture();

		const result = run({ weights: { 'area:ui': 1 } });

		const score = (id: number) => result.results.find((r) => r.labourId === id)!.score;
		expect(score(set5.id)).toBe(0);
		expect(score(unset.id)).toBe(0.5);
		expect(score(other.id)).toBe(0.5);
		expect(result.coverage.missing).toEqual({ 'area:ui': 2 });
	});

	it('never counts a built-in feature as missing', () => {
		fixture();

		const result = run({
			query: 'boss',
			weights: {
				keywords: 1,
				mentions: 1,
				pulled_in: 1,
				evidence: 1,
				unblocks: 1,
				quest_finish: 1,
				column: 1,
				age: 1,
				activity: 1
			}
		});

		expect(result.coverage.missing).toEqual({});
	});

	it('counts missing over all candidates, not only the returned ones', () => {
		fixture();

		const result = run({ weights: { impact: 1 }, limit: 1 });

		expect(result.coverage.missing).toEqual({ impact: 2 });
	});
});

describe('Score', () => {
	it('is the sum of weight times feature over the applied keys', () => {
		const realm = seedRealm(db, 'AM');
		scale(realm.id, 'impact', 1, 5);
		const top = seedLabour(db, { realmId: realm.id });
		const target = seedLabour(db, { realmId: realm.id });
		const unset = seedLabour(db, { realmId: realm.id });
		const source = seedLabour(db, { realmId: realm.id });
		set(top.id, { impact: 5 });
		set(target.id, { impact: 3 });
		link(source.id, 'evidence', target.id);

		const result = run({ weights: { impact: 2, evidence: -3 } });

		const score = (id: number) => result.results.find((r) => r.labourId === id)!.score;
		expect(score(top.id)).toBeCloseTo(2, 10);
		expect(score(target.id)).toBeCloseTo(2 * 0.5 - 3 * (1 / 3), 10);
		expect(score(unset.id)).toBeCloseTo(1, 10);
		expect(score(source.id)).toBeCloseTo(1, 10);
		expect(ids(result)).toEqual([top.id, unset.id, source.id, target.id]);
	});

	it('is 0 for a survey whose every key is ignored', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });

		expect(run({ weights: { ghost: 3 } }).results[0].score).toBe(0);
	});
});

describe('order', () => {
	it('puts the highest Score first at temperature 0', () => {
		const { rated } = ratedFour();

		const result = run({ weights: { impact: -1 } });

		expect(ids(result)).toEqual([...rated].reverse().map((l) => l.id));
		expect(result.results.map((r) => r.score)).toEqual([-0.25, -0.5, -0.75, -1]);
	});

	it('keeps board order among exactly equal Scores', () => {
		const realm = seedRealm(db, 'AM');
		scale(realm.id, 'impact', 1, 5);
		const labours3 = [3, 5, 3, 5, 3].map((value) => {
			const labour = seedLabour(db, { realmId: realm.id });
			set(labour.id, { impact: value });
			return labour;
		});

		const result = run({ weights: { impact: 1 } });

		expect(ids(result)).toEqual([1, 3, 0, 2, 4].map((i) => labours3[i].id));
	});

	it('applies limit after ordering', () => {
		const { rated } = ratedFour();

		const result = run({ weights: { impact: -1 }, limit: 2 });

		expect(ids(result)).toEqual([rated[3].id, rated[2].id]);
	});

	it('returns 15 results by default', () => {
		const realm = seedRealm(db, 'AM');
		for (let i = 0; i < 16; i++) seedLabour(db, { realmId: realm.id });

		const result = run();

		expect(result.results).toHaveLength(15);
		expect(result.coverage.candidates).toBe(16);
	});

	it('orders by Score plus temperature x sigma x gumbel noise, one draw per candidate in board order', () => {
		const { rated, scores } = ratedFour();
		const draws = [0.05, 0.95, 0.5, 0.9];
		const { random, drawn } = sampler(draws);

		const result = run({ weights: { impact: 1 }, temperature: 1 }, { random });

		const expected = noisyOrder(scores, 1, draws);
		expect(expected).toEqual([1, 3, 0, 2]);
		expect(ids(result)).toEqual(expected.map((i) => rated[i].id));
		expect(drawn()).toBe(4);
	});

	it('shows the Score itself, not the noisy value', () => {
		const { rated, scores } = ratedFour();
		const { random } = sampler([0.05, 0.95, 0.5, 0.9]);

		const result = run({ weights: { impact: 1 }, temperature: 1 }, { random });

		const byId = new Map(result.results.map((r) => [r.labourId, r.score]));
		rated.forEach((labour, i) => expect(byId.get(labour.id)).toBeCloseTo(scores[i], 10));
	});

	it('scales the noise with the temperature', () => {
		const { rated, scores } = ratedFour();
		const draws = [0.05, 0.95, 0.5, 0.9];

		for (const temperature of [0.3, 2]) {
			const result = run(
				{ weights: { impact: 1 }, temperature },
				{ random: sampler(draws).random }
			);

			expect(ids(result), String(temperature)).toEqual(
				noisyOrder(scores, temperature, draws).map((i) => rated[i].id)
			);
		}
	});

	it('draws for every candidate and takes sigma over all of them, then cuts to limit', () => {
		const { rated, scores } = ratedFour();
		const draws = [0.05, 0.95, 0.5, 0.9];
		const { random, drawn } = sampler(draws);

		const result = run({ weights: { impact: 1 }, temperature: 2, limit: 2 }, { random });

		expect(ids(result)).toEqual(
			noisyOrder(scores, 2, draws)
				.slice(0, 2)
				.map((i) => rated[i].id)
		);
		expect(drawn()).toBe(4);
	});

	it('defaults the temperature to 0.3', () => {
		const { rated, scores } = ratedFour();
		const draws = [0.05, 0.95, 0.5, 0.9];

		const result = survey(
			db,
			actor,
			{ weights: { impact: 1 } },
			{ now: NOW, random: sampler(draws).random }
		);

		expect(noisyOrder(scores, 0.3, draws)).not.toEqual([0, 1, 2, 3]);
		expect(ids(result)).toEqual(noisyOrder(scores, 0.3, draws).map((i) => rated[i].id));
	});

	it('draws from Math.random when no random is given', () => {
		const { rated, scores } = ratedFour();
		const draws = [0.05, 0.95, 0.5, 0.9];
		const { random } = sampler(draws);
		vi.spyOn(Math, 'random').mockImplementation(random);

		const result = survey(db, actor, { weights: { impact: 1 }, temperature: 1 }, { now: NOW });

		expect(ids(result)).toEqual(noisyOrder(scores, 1, draws).map((i) => rated[i].id));
	});

	it('clamps draws of 0 and 1 into the open interval, keeping every Score finite', () => {
		const { rated, scores } = ratedFour();
		const draws = [1, 0, 0.5, 0];

		const result = run(
			{ weights: { impact: 1 }, temperature: 1 },
			{ random: sampler(draws).random }
		);

		expect(ids(result)).toEqual(noisyOrder(scores, 1, draws).map((i) => rated[i].id));
		expect(result.results.every((r) => Number.isFinite(r.score))).toBe(true);
	});

	it('adds no noise when every Score is equal, whatever the draws', () => {
		const realm = seedRealm(db, 'AM');
		const made = Array.from({ length: 4 }, () => seedLabour(db, { realmId: realm.id }));
		const draws = [0, 1, 0.001, 0.999];

		const result = run({ temperature: 2 }, { random: sampler(draws).random });

		expect(ids(result)).toEqual(made.map((l) => l.id));
		expect(result.results.map((r) => r.score)).toEqual([0, 0, 0, 0]);
	});

	it('adds no noise for a single candidate', () => {
		const realm = seedRealm(db, 'AM');
		const only = seedLabour(db, { realmId: realm.id });

		const result = run({ temperature: 2 }, { random: () => 0 });

		expect(ids(result)).toEqual([only.id]);
		expect(result.results[0].score).toBe(0);
	});

	it('breaks ties among equal noisy values in board order', () => {
		const realm = seedRealm(db, 'AM');
		scale(realm.id, 'impact', 0, 4);
		const made = [4, 4, 0, 0].map((value) => {
			const labour = seedLabour(db, { realmId: realm.id });
			set(labour.id, { impact: value });
			return labour;
		});

		const result = run({ weights: { impact: 1 }, temperature: 1 }, { random: () => 0.5 });

		expect(ids(result)).toEqual(made.map((l) => l.id));
	});
});

describe('each result', () => {
	it('carries the Labour, its current key, Realm, State, Assignee and Brief', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const bob = seedUser(db, 'bob');
		const moved = seedLabour(db, { realmId: am.id, title: 'Fix the boss', assigneeId: bob });
		const plain = seedLabour(db, { realmId: bl.id, title: 'Plain' });
		appraise(db, actor, [{ labourId: moved.id, brief: 'Boss HP bar flickers' }]);
		moveLabour(db, actor, moved.id, { realmId: bl.id });

		const result = run();

		expect(result.results).toEqual([
			{
				labourId: plain.id,
				key: 'BL-1',
				title: 'Plain',
				realmKey: 'BL',
				stateKey: 'todo',
				assigneeId: null,
				brief: '',
				score: 0,
				contributions: {}
			},
			{
				labourId: moved.id,
				key: 'BL-2',
				title: 'Fix the boss',
				realmKey: 'BL',
				stateKey: 'todo',
				assigneeId: bob,
				brief: 'Boss HP bar flickers',
				score: 0,
				contributions: {}
			}
		]);
		expect(result.sentiment).toEqual([]);
		expect(result.surveyId).toBeGreaterThan(0);
	});

	describe('contributions', () => {
		function fixture() {
			const realm = seedRealm(db, 'AM');
			for (const key of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) scale(realm.id, key, 0, 4);
			const set7 = seedLabour(db, { realmId: realm.id });
			const unset = seedLabour(db, { realmId: realm.id });
			set(set7.id, { s1: 4, s2: 3, s3: 2, s4: 1, s5: 0, s6: 4, s7: 2 });
			const weights = { s1: 1, s2: -2, s3: 3, s4: 4, s5: 10, s6: 0.5, s7: 1 };
			return { set7, unset, weights };
		}

		it('keeps the five largest by absolute value, largest first, exact zeros excluded, ties in weights order', () => {
			const { set7, weights } = fixture();

			const item = run({ weights }).results.find((r) => r.labourId === set7.id)!;

			expect(Object.keys(item.contributions)).toEqual(['s2', 's3', 's1', 's4', 's6']);
			expect(item.contributions).toEqual({ s2: -1.5, s3: 1.5, s1: 1, s4: 1, s6: 0.5 });
			expect(item.score).toBeCloseTo(3, 10);
		});

		it('counts the 0.5 taken for missing data as a contribution', () => {
			const { unset, weights } = fixture();

			const item = run({ weights }).results.find((r) => r.labourId === unset.id)!;

			expect(Object.keys(item.contributions)).toEqual(['s5', 's4', 's3', 's2', 's1']);
			expect(item.contributions).toEqual({ s5: 5, s4: 2, s3: 1.5, s2: -1, s1: 0.5 });
		});

		it('lists fewer than five when fewer are non-zero, and none when all are', () => {
			const { set7 } = fixture();

			const few = run({ weights: { s1: 1, s5: 1, s6: 0 } }).results.find(
				(r) => r.labourId === set7.id
			)!;
			const none = run({ weights: { s5: 1 } }).results.find((r) => r.labourId === set7.id)!;

			expect(few.contributions).toEqual({ s1: 1 });
			expect(none.contributions).toEqual({});
		});

		it('omits ignored keys', () => {
			const { set7 } = fixture();

			const item = run({ weights: { s1: 1, ghost: 5, similarity: 5 } }).results.find(
				(r) => r.labourId === set7.id
			)!;

			expect(item.contributions).toEqual({ s1: 1 });
		});

		it('includes built-in features among the keys', () => {
			const { set7 } = fixture();
			touch(set7.id, { createdAt: daysAgo(30) });

			const item = run({ weights: { age: 4, s1: 1 } }).results.find((r) => r.labourId === set7.id)!;

			expect(Object.keys(item.contributions)).toEqual(['age', 's1']);
			expect(item.contributions.age).toBeCloseTo(2, 10);
		});
	});

	describe('values and show', () => {
		function fixture() {
			const am = seedRealm(db, 'AM');
			const bl = seedRealm(db, 'BL');
			scale(am.id, 'impact', 1, 5);
			tags(am.id, 'area', ['ui', 'api']);
			text(am.id, 'notes');
			scale(bl.id, 'impact', 0, 10);
			const a = seedLabour(db, { realmId: am.id });
			const b = seedLabour(db, { realmId: bl.id });
			set(a.id, { impact: 4, area: ['ui', 'api'] });
			set(b.id, { impact: 2 });
			return { am, bl, a, b };
		}

		it('has no values property unless show is given', () => {
			fixture();

			for (const item of run().results) expect(item).not.toHaveProperty('values');
		});

		it('gives each Labour the shown values its own Realm has and it holds', () => {
			const { a, b } = fixture();

			const result = run({ show: ['impact', 'area', 'notes'] });

			const values = (id: number) => result.results.find((r) => r.labourId === id)!.values;
			expect(values(a.id)).toEqual({ impact: 4, area: ['api', 'ui'] });
			expect(values(b.id)).toEqual({ impact: 2 });
			expect(result.ignored).toEqual([]);
		});

		it('gives text values as readValues gives them', () => {
			const { a } = fixture();
			set(a.id, { notes: '  Check the HP bar.  ' });

			const result = run({ show: ['notes'] });

			expect(result.results.find((r) => r.labourId === a.id)!.values).toEqual({
				notes: 'Check the HP bar.'
			});
		});

		it('is an empty object for an empty show', () => {
			fixture();

			for (const item of run({ show: [] }).results) expect(item.values).toEqual({});
		});

		it('ignores a show key no surveyed Realm has', () => {
			const { bl } = fixture();

			const result = run({ realmIds: [bl.id], show: ['impact', 'area', 'ghost'] });

			expect(result.ignored).toEqual(['area', 'ghost']);
			expect(result.results[0].values).toEqual({ impact: 2 });
		});

		it('is independent of the weights', () => {
			const { a } = fixture();

			const result = run({ weights: { age: 1 }, show: ['impact'] });

			expect(result.results.find((r) => r.labourId === a.id)!.values).toEqual({ impact: 4 });
		});
	});
});

describe('coverage', () => {
	it('counts unappraised and stale candidates over all of them, not only the returned', () => {
		const realm = seedRealm(db, 'AM');
		const never = seedLabour(db, { realmId: realm.id });
		const current = seedLabour(db, { realmId: realm.id });
		const edited = seedLabour(db, { realmId: realm.id });
		const done = seedLabour(db, { realmId: realm.id });
		for (const labour of [current, edited, done]) {
			appraise(db, actor, [{ labourId: labour.id, stamp: contentHash(db, labour.id) }]);
		}
		updateLabour(db, actor, edited.id, { title: 'A new title' });
		close(done);

		const result = run({ limit: 1 });

		expect(ids(result)).toEqual([never.id]);
		expect(result.coverage).toEqual({
			candidates: 3,
			unappraised: 1,
			stale: 1,
			unembedded: 3,
			missing: {}
		});
	});

	it('counts a Labour commented on after its stamp as stale, and a moved one as current', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const commented = seedLabour(db, { realmId: am.id });
		const moved = seedLabour(db, { realmId: am.id });
		for (const labour of [commented, moved]) {
			appraise(db, actor, [{ labourId: labour.id, stamp: contentHash(db, labour.id) }]);
		}
		addComment(db, actor, commented.id, 'New information');
		moveLabour(db, actor, moved.id, { realmId: bl.id });

		const result = run();

		expect(result.coverage.unappraised).toBe(0);
		expect(result.coverage.stale).toBe(1);
	});

	it('counts every candidate as unembedded', () => {
		const realm = seedRealm(db, 'AM');
		for (let i = 0; i < 3; i++) seedLabour(db, { realmId: realm.id });

		expect(run().coverage.unembedded).toBe(3);
	});

	it('reads staleness and appraisal in batches, never one query per Labour', () => {
		function statements(count: number): number {
			const realm = seedRealm(db, 'AM');
			scale(realm.id, 'impact', 0, 4);
			for (let i = 0; i < count; i++) {
				const labour = seedLabour(db, { realmId: realm.id });
				set(labour.id, { impact: i % 5 });
				if (i % 2 === 0) {
					appraise(db, actor, [{ labourId: labour.id, stamp: contentHash(db, labour.id) }]);
				}
				if (i % 4 === 0) updateLabour(db, actor, labour.id, { title: 'Edited' });
			}
			const spy = vi.spyOn(db.$client, 'prepare');
			run({ query: 'edited', weights: { impact: 1, keywords: 1, age: 1, activity: 1 } });
			const total = spy.mock.calls.length;
			spy.mockRestore();
			return total;
		}

		const few = statements(4);
		db.$client.close();
		db = testDb();
		actor = seedActor(db);
		const many = statements(40);

		expect(many).toBe(few);
	});
});

describe('storage', () => {
	it('stores every Survey with its request, results and times, and returns its id', () => {
		const am = seedRealm(db, 'AM');
		const bob = seedUser(db, 'bob');
		scale(am.id, 'impact', 0, 4);
		const first = seedLabour(db, { realmId: am.id });
		const second = seedLabour(db, { realmId: am.id });
		set(first.id, { impact: 1 });
		set(second.id, { impact: 4 });
		for (const labour of [first, second]) {
			updateLabour(db, actor, labour.id, { labels: ['bug'] });
		}

		const result = run({
			realmIds: [am.id],
			forUserId: bob,
			query: '  boss  ',
			weights: { impact: 1 },
			filter: { assigneeIds: [null], labels: ['bug'], includeClosed: { withinDays: 5 } },
			temperature: 0,
			limit: 1,
			show: ['impact']
		});

		const row = db.select().from(surveys).where(eq(surveys.id, result.surveyId)).get()!;
		expect(db.select().from(surveys).all()).toHaveLength(1);
		expect(row.actorId).toBe(actor.id);
		expect(row.forId).toBe(bob);
		expect(row.createdAt).toEqual(NOW);
		expect(json(row.request)).toMatchObject({
			realmIds: [am.id],
			forUserId: bob,
			query: 'boss',
			weights: { impact: 1 },
			filter: { assigneeIds: [null], labels: ['bug'], includeClosed: { withinDays: 5 } },
			temperature: 0,
			limit: 1,
			show: ['impact']
		});
		expect(json(row.results)).toEqual([{ labour: second.id, score: 1 }]);
	});

	it('fills the defaults of temperature and limit into the request', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });

		const result = survey(db, actor, { weights: NEUTRAL }, { now: NOW, random: () => 0.5 });

		const row = db.select().from(surveys).where(eq(surveys.id, result.surveyId)).get()!;
		expect(json(row.request)).toMatchObject({ weights: NEUTRAL, temperature: 0.3, limit: 15 });
	});

	it('records the actor as the User it is for when forUserId is absent', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });

		const result = run();

		const row = db.select().from(surveys).where(eq(surveys.id, result.surveyId)).get()!;
		expect(row.forId).toBe(actor.id);
	});

	it('stores results in the returned order, with the Score itself', () => {
		const { rated, scores } = ratedFour();
		const draws = [0.05, 0.95, 0.5, 0.9];

		const result = run(
			{ weights: { impact: 1 }, temperature: 1 },
			{ random: sampler(draws).random }
		);

		const row = db.select().from(surveys).where(eq(surveys.id, result.surveyId)).get()!;
		const order = noisyOrder(scores, 1, draws);
		expect(json(row.results)).toEqual(
			order.map((i) => ({ labour: rated[i].id, score: scores[i] }))
		);
	});

	it('stores each Survey under its own id', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });

		const one = run();
		const two = run();

		expect(two.surveyId).not.toBe(one.surveyId);
		expect(db.select().from(surveys).all()).toHaveLength(2);
	});

	it('dates the Survey by the current time when now is not given', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const result = survey(db, actor, { weights: NEUTRAL, temperature: 0 });

		const row = db.select().from(surveys).where(eq(surveys.id, result.surveyId)).get()!;
		expect(row.createdAt).toEqual(NOW);
	});

	it('records no Event and leaves every Labour untouched', () => {
		const realm = seedRealm(db, 'AM');
		scale(realm.id, 'impact', 0, 4);
		const a = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id });
		set(a.id, { impact: 2 });
		touch(a.id, { updatedAt: daysAgo(40) });
		const eventsBefore = db.select().from(events).all();
		const laboursBefore = db.select().from(labours).all();

		run({
			weights: { impact: 1, age: 1, activity: 1 },
			query: 'x',
			show: ['impact'],
			temperature: 1
		});

		expect(db.select().from(events).all()).toEqual(eventsBefore);
		expect(db.select().from(labours).all()).toEqual(laboursBefore);
	});
});

describe('pruneSurveys', () => {
	function surveysAt(...times: Date[]) {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		return times.map((now) => run({}, { now }).surveyId);
	}

	it('deletes Surveys created more than the retention before now, and returns how many', () => {
		const [old, edge, recent] = surveysAt(
			new Date(NOW.getTime() - 5 * DAY - 1),
			new Date(NOW.getTime() - 5 * DAY),
			daysAgo(1)
		);

		const deleted = pruneSurveys(db, 5 * DAY, NOW.getTime());

		expect(deleted).toBe(1);
		const left = db
			.select({ id: surveys.id })
			.from(surveys)
			.all()
			.map((r) => r.id);
		expect(left).toEqual([edge, recent]);
		expect(left).not.toContain(old);
	});

	it('returns 0 when nothing is old enough', () => {
		surveysAt(daysAgo(1), daysAgo(2));

		expect(pruneSurveys(db, 5 * DAY, NOW.getTime())).toBe(0);
		expect(db.select().from(surveys).all()).toHaveLength(2);
	});

	it('deletes every Survey past the retention', () => {
		surveysAt(daysAgo(10), daysAgo(20), daysAgo(30), daysAgo(1));

		expect(pruneSurveys(db, 5 * DAY, NOW.getTime())).toBe(3);
		expect(db.select().from(surveys).all()).toHaveLength(1);
	});

	it('measures from the current time when now is not given', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		run({}, { now: new Date(Date.now() - 10 * DAY) });
		run({}, { now: new Date(Date.now() - 1 * DAY) });

		expect(pruneSurveys(db, 5 * DAY)).toBe(1);
		expect(db.select().from(surveys).all()).toHaveLength(1);
	});

	it('touches neither Events nor Labours', () => {
		surveysAt(daysAgo(10));
		const eventsBefore = db.select().from(events).all();
		const laboursBefore = db.select().from(labours).all();

		pruneSurveys(db, 5 * DAY, NOW.getTime());

		expect(db.select().from(events).all()).toEqual(eventsBefore);
		expect(db.select().from(labours).all()).toEqual(laboursBefore);
	});
});
