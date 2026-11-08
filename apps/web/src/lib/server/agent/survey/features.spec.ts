import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { defineAttribute, setValues } from '#lib/server/agent/attributes.ts';
import { keywordScores } from '#lib/server/agent/search.ts';
import { survey, type SurveyInput } from '#lib/server/agent/survey/index.ts';
import type { Db } from '#lib/server/db/client.ts';
import { comments, labours, mentions } from '#lib/server/db/schema.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { rankLabour, updateLabour } from '#lib/server/domain/labours.ts';
import { addQuestLabours, createQuest } from '#lib/server/domain/quests.ts';
import { listStates } from '#lib/server/domain/states.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import {
	seedActor,
	seedLabour,
	seedRealm,
	seedUser,
	anyRealmId
} from '#lib/server/test/fixtures.ts';

let db: Db;
let actor: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function survey1(weights: Record<string, number>, extra: Partial<SurveyInput> = {}) {
	return survey(db, actor, { weights, temperature: 0, limit: 50, ...extra }, { now: NOW });
}

// Each Labour's Score under one weight of 1, which is that feature itself.
async function featureScores(weights: Record<string, number>, extra: Partial<SurveyInput> = {}) {
	const result = await survey1(weights, extra);
	return {
		result,
		of: (labour: { id: number }) => {
			const item = result.results.find((r) => r.labourId === labour.id);
			if (item === undefined) throw new Error(`Labour ${labour.id} is not in the results`);
			return item.score;
		}
	};
}

const closedOf = async (realmId: number) =>
	(await listStates(db, realmId)).find((s) => s.isClosed)!;

async function close(labour: { id: number; realmId: number }) {
	await updateLabour(db, actor, labour.id, { stateId: (await closedOf(labour.realmId)).id });
}

async function touch(id: number, patch: { createdAt?: Date; updatedAt?: Date }) {
	await db.update(labours).set(patch).where(eq(labours.id, id));
}

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

async function text(realmId: number, key: string) {
	await defineAttribute(db, actor, realmId, { key, kind: 'text', label: key, rubric: 'rubric' });
}

const set = (labourId: number, values: Record<string, unknown>) =>
	setValues(db, actor, labourId, values);

async function link(from: number, type: 'evidence' | 'blocks', to: number) {
	await appraise(db, actor, [{ labourId: from, links: [{ type, to }] }]);
}

async function mentionLabour(
	sourceLabourId: number,
	labourId: number,
	firstSeenAt: Date,
	commentId?: number
) {
	await db.insert(mentions).values({
		sourceLabourId,
		labourId,
		commentId: commentId ?? null,
		authorId: actor.id,
		firstSeenAt
	});
}

async function mentionUser(
	sourceLabourId: number,
	userId: number,
	firstSeenAt: Date,
	commentId?: number
) {
	await db.insert(mentions).values({
		sourceLabourId,
		userId,
		commentId: commentId ?? null,
		authorId: actor.id,
		firstSeenAt
	});
}

const decay = (days: number) => 2 ** (-days / 7);

describe('keywords', () => {
	async function fixture() {
		const realm = await seedRealm(db, 'AM');
		const bob = await seedUser(db, 'bob');
		const best = await seedLabour(db, {
			realmId: realm.id,
			title: 'Boss HP bar',
			description: 'boss hp boss hp',
			assigneeId: bob
		});
		const weak = await seedLabour(db, {
			realmId: realm.id,
			title: 'Arena redesign for the boss fight',
			description: 'lighting pass'
		});
		const none = await seedLabour(db, { realmId: realm.id, title: 'Unrelated chore' });
		const shut = await seedLabour(db, {
			realmId: realm.id,
			title: 'Boss HP',
			description: 'boss hp boss hp boss hp boss hp'
		});
		await close(shut);
		return { best, weak, none, shut };
	}

	it('re-scales the match scores so the best candidate is 1 and the others share of it', async () => {
		const { best, weak, none, shut } = await fixture();
		const map = await keywordScores(db, 'boss hp');
		expect(map.get(shut.id), 'the closed Labour is the best match overall').toBeGreaterThan(
			Math.max(map.get(best.id)!, map.get(weak.id)!)
		);
		expect(map.get(weak.id)).toBeGreaterThan(0);

		const { of } = await featureScores({ keywords: 1 }, { query: 'boss hp' });

		const top = Math.max(map.get(best.id)!, map.get(weak.id)!);
		expect(Math.max(of(best), of(weak))).toBe(1);
		expect(of(best)).toBeCloseTo(map.get(best.id)! / top, 10);
		expect(of(weak)).toBeCloseTo(map.get(weak.id)! / top, 10);
		expect(of(none)).toBe(0);
	});

	it('re-scales over the candidates after the filters, not over every match', async () => {
		const { best, weak } = await fixture();
		const map = await keywordScores(db, 'boss hp');
		expect(map.get(best.id), 'the filtered-out Labour matches better').toBeGreaterThan(
			map.get(weak.id)!
		);

		const { of, result } = await featureScores(
			{ keywords: 1 },
			{ query: 'boss hp', filter: { assigneeIds: [null] } }
		);

		expect(of(weak)).toBe(1);
		expect(result.results.map((r) => r.labourId)).not.toContain(best.id);
	});

	it('counts a closed best match when closed Labours are candidates', async () => {
		const { best, shut } = await fixture();
		const map = await keywordScores(db, 'boss hp');

		const { of } = await featureScores(
			{ keywords: 1 },
			{ query: 'boss hp', filter: { includeClosed: true } }
		);

		expect(of(shut)).toBe(1);
		expect(of(best)).toBeCloseTo(map.get(best.id)! / map.get(shut.id)!, 10);
		expect(of(best)).toBeLessThan(1);
	});

	it('is 0 for a query with no word, without error', async () => {
		const { best, none } = await fixture();

		const { of, result } = await featureScores({ keywords: 1 }, { query: '!!! ???' });

		expect(of(best)).toBe(0);
		expect(of(none)).toBe(0);
		expect(result.ignored).toEqual([]);
	});

	it('matches a Brief', async () => {
		const { none, best } = await fixture();
		await appraise(db, actor, [{ labourId: none.id, brief: 'shader flicker on the ground' }]);

		const { of } = await featureScores({ keywords: 1 }, { query: 'flicker' });

		expect(of(none)).toBe(1);
		expect(of(best)).toBe(0);
	});

	it('does not narrow the candidates: a query alone filters nothing', async () => {
		const { none } = await fixture();

		const { result } = await featureScores({ evidence: 1 }, { query: 'boss' });

		expect(result.results.map((r) => r.labourId)).toContain(none.id);
		expect(result.coverage.candidates).toBe(3);
	});
});

describe('mentions', () => {
	it('is 1 - 2^(-s), s the sum of 2^(-d/7) over the rows naming the Labour, d the age of firstSeenAt', async () => {
		const realm = await seedRealm(db, 'AM');
		const target = await seedLabour(db, { realmId: realm.id });
		const lone = await seedLabour(db, { realmId: realm.id });
		const unmentioned = await seedLabour(db, { realmId: realm.id });
		const one = await seedLabour(db, { realmId: realm.id });
		const two = await seedLabour(db, { realmId: realm.id });
		await mentionLabour(one.id, target.id, daysAgo(7));
		await mentionLabour(two.id, target.id, daysAgo(14));
		await mentionLabour(one.id, lone.id, daysAgo(21));

		const { of } = await featureScores({ mentions: 1 });

		expect(of(target)).toBeCloseTo(1 - 2 ** -(decay(7) + decay(14)), 10);
		expect(of(lone)).toBeCloseTo(1 - 2 ** -decay(21), 10);
		expect(of(unmentioned)).toBe(0);
		expect(of(one)).toBe(0);
	});

	it('weighs a newer Mention more than an older one', async () => {
		const realm = await seedRealm(db, 'AM');
		const fresh = await seedLabour(db, { realmId: realm.id });
		const old = await seedLabour(db, { realmId: realm.id });
		const source = await seedLabour(db, { realmId: realm.id });
		await mentionLabour(source.id, fresh.id, daysAgo(1));
		await mentionLabour(source.id, old.id, daysAgo(60));

		const { of } = await featureScores({ mentions: 1 });

		expect(of(fresh)).toBeCloseTo(1 - 2 ** -decay(1), 10);
		expect(of(old)).toBeCloseTo(1 - 2 ** -decay(60), 10);
		expect(of(fresh)).toBeGreaterThan(of(old));
	});

	it('clamps a future firstSeenAt to an age of 0', async () => {
		const realm = await seedRealm(db, 'AM');
		const target = await seedLabour(db, { realmId: realm.id });
		const source = await seedLabour(db, { realmId: realm.id });
		await mentionLabour(source.id, target.id, daysAgo(-9));

		const { of } = await featureScores({ mentions: 1 });

		expect(of(target)).toBeCloseTo(0.5, 10);
	});

	it('ignores rows that name a User', async () => {
		const realm = await seedRealm(db, 'AM');
		const bob = await seedUser(db, 'bob');
		const source = await seedLabour(db, { realmId: realm.id });
		const other = await seedLabour(db, { realmId: realm.id });
		await mentionUser(source.id, bob, daysAgo(1));
		await mentionUser(other.id, actor.id, daysAgo(1));

		const { of } = await featureScores({ mentions: 1 });

		expect(of(source)).toBe(0);
		expect(of(other)).toBe(0);
	});
});

describe('pulled_in', () => {
	async function fixture() {
		const realm = await seedRealm(db, 'AM');
		const bob = await seedUser(db, 'bob');
		const twice = await seedLabour(db, { realmId: realm.id });
		const once = await seedLabour(db, { realmId: realm.id });
		const ofBob = await seedLabour(db, { realmId: realm.id });
		const named = await seedLabour(db, { realmId: realm.id });
		const target = await seedLabour(db, { realmId: realm.id });
		const comment = await addComment(db, actor, twice.id, 'ping');
		await mentionUser(twice.id, actor.id, daysAgo(7));
		await mentionUser(twice.id, actor.id, daysAgo(14), comment.id);
		await mentionUser(once.id, actor.id, daysAgo(21));
		await mentionUser(ofBob.id, bob, daysAgo(7));
		await mentionLabour(named.id, target.id, daysAgo(7));
		return { bob, twice, once, ofBob, named, target };
	}

	it('is the same decay over the rows naming the Survey User whose source is the Labour', async () => {
		const { twice, once, ofBob, named, target } = await fixture();

		const { of } = await featureScores({ pulled_in: 1 });

		expect(of(twice)).toBeCloseTo(1 - 2 ** -(decay(7) + decay(14)), 10);
		expect(of(once)).toBeCloseTo(1 - 2 ** -decay(21), 10);
		expect(of(ofBob)).toBe(0);
		expect(of(named)).toBe(0);
		expect(of(target)).toBe(0);
	});

	it('follows forUserId rather than the actor', async () => {
		const { bob, twice, once, ofBob } = await fixture();

		const { of } = await featureScores({ pulled_in: 1 }, { forUserId: bob });

		expect(of(ofBob)).toBeCloseTo(1 - 2 ** -decay(7), 10);
		expect(of(twice)).toBe(0);
		expect(of(once)).toBe(0);
	});

	it('clamps a future firstSeenAt to an age of 0', async () => {
		const realm = await seedRealm(db, 'AM');
		const source = await seedLabour(db, { realmId: realm.id });
		await mentionUser(source.id, actor.id, daysAgo(-3));

		const { of } = await featureScores({ pulled_in: 1 });

		expect(of(source)).toBeCloseTo(0.5, 10);
	});
});

describe('evidence', () => {
	it('is n / (n + 2), n the evidence Links into the Labour', async () => {
		const realm = await seedRealm(db, 'AM');
		const three = await seedLabour(db, { realmId: realm.id });
		const one = await seedLabour(db, { realmId: realm.id });
		const none = await seedLabour(db, { realmId: realm.id });
		const first = await seedLabour(db, { realmId: realm.id });
		const second = await seedLabour(db, { realmId: realm.id });
		const third = await seedLabour(db, { realmId: realm.id });
		await close(third);
		for (const from of [first, second, third]) await link(from.id, 'evidence', three.id);
		await link(first.id, 'evidence', one.id);

		const { of } = await featureScores({ evidence: 1 }, { filter: { includeClosed: true } });

		expect(of(three)).toBeCloseTo(3 / 5, 10);
		expect(of(one)).toBeCloseTo(1 / 3, 10);
		expect(of(none)).toBe(0);
		expect(of(first)).toBe(0);
	});

	it('does not count other Link types or Links out of the Labour', async () => {
		const realm = await seedRealm(db, 'AM');
		const target = await seedLabour(db, { realmId: realm.id });
		const other = await seedLabour(db, { realmId: realm.id });
		await link(other.id, 'blocks', target.id);
		await appraise(db, actor, [
			{ labourId: other.id, links: [{ type: 'relates', to: target.id }] }
		]);
		await link(target.id, 'evidence', other.id);

		const { of } = await featureScores({ evidence: 1 });

		expect(of(target)).toBe(0);
		expect(of(other)).toBeCloseTo(1 / 3, 10);
	});
});

describe('unblocks', () => {
	it('is n / (n + 2), n the open Labours the Labour blocks, in any Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const blocker = await seedLabour(db, { realmId: am.id });
		const small = await seedLabour(db, { realmId: am.id });
		const free = await seedLabour(db, { realmId: am.id });
		const here = await seedLabour(db, { realmId: am.id });
		const there = await seedLabour(db, { realmId: bl.id });
		const done = await seedLabour(db, { realmId: bl.id });
		const lone = await seedLabour(db, { realmId: am.id });
		await close(done);
		await link(blocker.id, 'blocks', here.id);
		await link(blocker.id, 'blocks', there.id);
		await link(blocker.id, 'blocks', done.id);
		await link(small.id, 'blocks', lone.id);

		const { of } = await featureScores({ unblocks: 1 }, { realmIds: [am.id] });

		expect(of(blocker)).toBeCloseTo(2 / 4, 10);
		expect(of(small)).toBeCloseTo(1 / 3, 10);
		expect(of(free)).toBe(0);
		expect(of(here)).toBe(0);
	});

	it('does not count Links into the Labour or other Link types', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		await link(a.id, 'blocks', b.id);
		await link(a.id, 'evidence', b.id);

		const { of } = await featureScores({ unblocks: 1 });

		expect(of(a)).toBeCloseTo(1 / 3, 10);
		expect(of(b)).toBe(0);
	});
});

describe('quest_finish', () => {
	it('is the highest (closed + 1) / total over the Labour Quests, counting every Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const a = await seedLabour(db, { realmId: am.id });
		const shutHere = await seedLabour(db, { realmId: am.id });
		const shutThere = await seedLabour(db, { realmId: bl.id });
		const d = await seedLabour(db, { realmId: bl.id });
		const e = await seedLabour(db, { realmId: am.id });
		const lone = await seedLabour(db, { realmId: am.id });
		const g = await seedLabour(db, { realmId: am.id });
		const h = await seedLabour(db, { realmId: am.id });
		const i = await seedLabour(db, { realmId: am.id });
		for (const labour of [shutHere, shutThere, h, i]) await close(labour);
		const big = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Big',
			ownerId: actor.id
		});
		const small = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Small',
			ownerId: actor.id
		});
		const nearly = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Nearly',
			ownerId: actor.id
		});
		await addQuestLabours(db, actor, big.id, [a.id, shutHere.id, shutThere.id, d.id]);
		await addQuestLabours(db, actor, small.id, [a.id, e.id]);
		await addQuestLabours(db, actor, nearly.id, [g.id, h.id, i.id]);

		const { of } = await featureScores({ quest_finish: 1 });

		expect(of(a)).toBeCloseTo(3 / 4, 10);
		expect(of(d)).toBeCloseTo(3 / 4, 10);
		expect(of(e)).toBeCloseTo(1 / 2, 10);
		expect(of(g)).toBeCloseTo(1, 10);
		expect(of(lone)).toBe(0);
	});

	it('counts Labours of Realms outside the survey in the Quest totals', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const a = await seedLabour(db, { realmId: am.id });
		const shutThere = await seedLabour(db, { realmId: bl.id });
		const d = await seedLabour(db, { realmId: bl.id });
		await close(shutThere);
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Q',
			ownerId: actor.id
		});
		await addQuestLabours(db, actor, quest.id, [a.id, shutThere.id, d.id]);

		const { of } = await featureScores({ quest_finish: 1 }, { realmIds: [am.id] });

		expect(of(a)).toBeCloseTo(2 / 3, 10);
	});

	it('is 0 for a Closed Labour and for one in no Quest', async () => {
		const realm = await seedRealm(db, 'AM');
		const open = await seedLabour(db, { realmId: realm.id });
		const shut = await seedLabour(db, { realmId: realm.id });
		const loose = await seedLabour(db, { realmId: realm.id });
		await close(shut);
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Q',
			ownerId: actor.id
		});
		await addQuestLabours(db, actor, quest.id, [open.id, shut.id]);

		const { of } = await featureScores({ quest_finish: 1 }, { filter: { includeClosed: true } });

		expect(of(open)).toBeCloseTo(2 / 2, 10);
		expect(of(shut)).toBe(0);
		expect(of(loose)).toBe(0);
	});
});

describe('column', () => {
	it('is 1 - i / (n - 1) over the whole column, candidates or not', async () => {
		const realm = await seedRealm(db, 'AM');
		const bob = await seedUser(db, 'bob');
		await seedLabour(db, { realmId: realm.id });
		const c1 = await seedLabour(db, { realmId: realm.id, assigneeId: bob });
		await seedLabour(db, { realmId: realm.id });
		const c3 = await seedLabour(db, { realmId: realm.id, assigneeId: bob });

		const { of, result } = await featureScores({ column: 1 }, { filter: { assigneeIds: [bob] } });

		expect(result.coverage.candidates).toBe(2);
		expect(of(c1)).toBeCloseTo(1 - 1 / 3, 10);
		expect(of(c3)).toBe(0);
	});

	it('follows Rank, top being 1', async () => {
		const realm = await seedRealm(db, 'AM');
		const c0 = await seedLabour(db, { realmId: realm.id });
		const c1 = await seedLabour(db, { realmId: realm.id });
		const c2 = await seedLabour(db, { realmId: realm.id });
		await rankLabour(db, actor, c2.id, 'top');

		const { of } = await featureScores({ column: 1 });

		expect(of(c2)).toBe(1);
		expect(of(c0)).toBeCloseTo(0.5, 10);
		expect(of(c1)).toBe(0);
	});

	it('is 1 for a Labour alone in its column', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const alone = await seedLabour(db, { realmId: am.id });
		const top = await seedLabour(db, { realmId: bl.id });
		const bottom = await seedLabour(db, { realmId: bl.id });

		const { of } = await featureScores({ column: 1 });

		expect(of(alone)).toBe(1);
		expect(of(top)).toBe(1);
		expect(of(bottom)).toBe(0);
	});

	it('uses the place in the whole column for a lone candidate', async () => {
		const realm = await seedRealm(db, 'AM');
		const bob = await seedUser(db, 'bob');
		await seedLabour(db, { realmId: realm.id });
		const middle = await seedLabour(db, { realmId: realm.id, assigneeId: bob });
		await seedLabour(db, { realmId: realm.id });

		const { of } = await featureScores({ column: 1 }, { filter: { assigneeIds: [bob] } });

		expect(of(middle)).toBeCloseTo(0.5, 10);
	});

	it('does not count Labours of other columns', async () => {
		const realm = await seedRealm(db, 'AM');
		const only = await seedLabour(db, { realmId: realm.id });
		const shut = await seedLabour(db, { realmId: realm.id });
		await close(shut);

		const { of } = await featureScores({ column: 1 });

		expect(of(only)).toBe(1);
	});
});

describe('age', () => {
	it('is d / (d + 30), d the age of createdAt in days', async () => {
		const realm = await seedRealm(db, 'AM');
		const dated = await Promise.all(
			[0, 30, 60, 90].map(async (days) => {
				const labour = await seedLabour(db, { realmId: realm.id });
				await touch(labour.id, { createdAt: daysAgo(days), updatedAt: NOW });
				return labour;
			})
		);

		const { of } = await featureScores({ age: 1 });

		expect(of(dated[0])).toBe(0);
		expect(of(dated[1])).toBeCloseTo(0.5, 10);
		expect(of(dated[2])).toBeCloseTo(60 / 90, 10);
		expect(of(dated[3])).toBeCloseTo(0.75, 10);
	});

	it('uses fractions of a day', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await touch(labour.id, { createdAt: new Date(NOW.getTime() - 1.5 * DAY) });

		const { of } = await featureScores({ age: 1 });

		expect(of(labour)).toBeCloseTo(1.5 / 31.5, 10);
	});

	it('clamps a future createdAt to an age of 0', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await touch(labour.id, { createdAt: daysAgo(-10) });

		const { of } = await featureScores({ age: 1 });

		expect(of(labour)).toBe(0);
	});

	it('ignores updatedAt', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await touch(labour.id, { createdAt: daysAgo(30), updatedAt: NOW });

		const { of } = await featureScores({ age: 1 });

		expect(of(labour)).toBeCloseTo(0.5, 10);
	});
});

describe('activity', () => {
	async function labourWith(
		realmId: number,
		updatedAgo: number,
		commentsAgo: number[] = [],
		edited?: number
	) {
		const labour = await seedLabour(db, { realmId });
		for (const [i, ago] of commentsAgo.entries()) {
			const comment = await addComment(db, actor, labour.id, `Comment ${i}`);
			await db
				.update(comments)
				.set({ createdAt: daysAgo(ago), updatedAt: edited === undefined ? null : daysAgo(edited) })
				.where(eq(comments.id, comment.id));
		}
		await touch(labour.id, { updatedAt: daysAgo(updatedAgo) });
		return labour;
	}

	it('is 2^(-d/7), d the age of updatedAt', async () => {
		const realm = await seedRealm(db, 'AM');
		const week = await labourWith(realm.id, 7);
		const fortnight = await labourWith(realm.id, 14);
		const day = await labourWith(realm.id, 1);

		const { of } = await featureScores({ activity: 1 });

		expect(of(week)).toBeCloseTo(0.5, 10);
		expect(of(fortnight)).toBeCloseTo(0.25, 10);
		expect(of(day)).toBeCloseTo(decay(1), 10);
	});

	it('takes the later of updatedAt and the newest Comment createdAt', async () => {
		const realm = await seedRealm(db, 'AM');
		const commented = await labourWith(realm.id, 14, [7]);
		const recent = await labourWith(realm.id, 3, [10]);
		const two = await labourWith(realm.id, 20, [20, 7, 12]);

		const { of } = await featureScores({ activity: 1 });

		expect(of(commented)).toBeCloseTo(0.5, 10);
		expect(of(recent)).toBeCloseTo(decay(3), 10);
		expect(of(two)).toBeCloseTo(0.5, 10);
	});

	it('uses a Comment createdAt, not when it was edited', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await labourWith(realm.id, 14, [14], 1);

		const { of } = await featureScores({ activity: 1 });

		expect(of(labour)).toBeCloseTo(0.25, 10);
	});

	it('clamps a future updatedAt or Comment date to an age of 0', async () => {
		const realm = await seedRealm(db, 'AM');
		const futureUpdate = await labourWith(realm.id, -5);
		const futureComment = await labourWith(realm.id, 20, [-2]);

		const { of } = await featureScores({ activity: 1 });

		expect(of(futureUpdate)).toBe(1);
		expect(of(futureComment)).toBe(1);
	});
});

describe('Attribute features', () => {
	it('normalises a scale value as (value - min) / (max - min) in the Labour own Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const cx = await seedRealm(db, 'CX');
		await scale(am.id, 'impact', 1, 5);
		await scale(bl.id, 'impact', 0, 10);
		await scale(cx.id, 'impact', -2, 2);
		const at = async (realmId: number, value: number) => {
			const labour = await seedLabour(db, { realmId });
			await set(labour.id, { impact: value });
			return labour;
		};
		const amMin = await at(am.id, 1);
		const amLow = await at(am.id, 2);
		const amMid = await at(am.id, 3);
		const amMax = await at(am.id, 5);
		const blThree = await at(bl.id, 3);
		const cxZero = await at(cx.id, 0);
		const cxMin = await at(cx.id, -2);

		const { of, result } = await featureScores({ impact: 1 });

		expect(of(amMin)).toBe(0);
		expect(of(amLow)).toBeCloseTo(0.25, 10);
		expect(of(amMid)).toBeCloseTo(0.5, 10);
		expect(of(amMax)).toBe(1);
		expect(of(blThree)).toBeCloseTo(0.3, 10);
		expect(of(cxZero)).toBeCloseTo(0.5, 10);
		expect(of(cxMin)).toBe(0);
		expect(result.coverage.missing).toEqual({});
	});

	it('takes 0.5 for an unset scale value', async () => {
		const realm = await seedRealm(db, 'AM');
		await scale(realm.id, 'impact', 1, 5);
		const unset = await seedLabour(db, { realmId: realm.id });

		const { of, result } = await featureScores({ impact: 1 });

		expect(of(unset)).toBe(0.5);
		expect(result.coverage.missing).toEqual({ impact: 1 });
	});

	it('is 1 when the Labour holds the tags member and 0 when it holds others', async () => {
		const realm = await seedRealm(db, 'AM');
		await tags(realm.id, 'area', ['ui', 'api', 'ux']);
		const holds = await seedLabour(db, { realmId: realm.id });
		const others = await seedLabour(db, { realmId: realm.id });
		const unset = await seedLabour(db, { realmId: realm.id });
		await set(holds.id, { area: ['ui', 'api'] });
		await set(others.id, { area: ['ux'] });

		const ui = await featureScores({ 'area:ui': 1 });
		const ux = await featureScores({ 'area:ux': 1 });

		expect(ui.of(holds)).toBe(1);
		expect(ui.of(others)).toBe(0);
		expect(ui.of(unset)).toBe(0.5);
		expect(ux.of(holds)).toBe(0);
		expect(ux.of(others)).toBe(1);
		expect(ui.result.coverage.missing).toEqual({ 'area:ui': 1 });
	});

	it('scales the contribution by the weight, negative weights included', async () => {
		const realm = await seedRealm(db, 'AM');
		await scale(realm.id, 'impact', 0, 4);
		await tags(realm.id, 'area', ['ui']);
		const labour = await seedLabour(db, { realmId: realm.id });
		await set(labour.id, { impact: 3, area: ['ui'] });

		const { result } = await featureScores({ impact: -4, 'area:ui': 2.5 });

		expect(result.results[0].contributions).toEqual({ impact: -3, 'area:ui': 2.5 });
		expect(result.results[0].score).toBeCloseTo(-0.5, 10);
	});

	describe('keys held with different kinds in different Realms', () => {
		async function fixture() {
			const am = await seedRealm(db, 'AM');
			const bl = await seedRealm(db, 'BL');
			const cx = await seedRealm(db, 'CX');
			await scale(am.id, 'impact', 1, 5);
			await tags(bl.id, 'impact', ['x']);
			await text(cx.id, 'impact');
			await tags(am.id, 'area', ['ui']);
			await scale(bl.id, 'area', 0, 4);
			await text(cx.id, 'area');
			const a = await seedLabour(db, { realmId: am.id });
			const b = await seedLabour(db, { realmId: bl.id });
			const c = await seedLabour(db, { realmId: cx.id });
			await set(a.id, { impact: 5, area: ['ui'] });
			await set(b.id, { impact: ['x'], area: 4 });
			await set(c.id, { impact: 'words', area: 'words' });
			return { am, bl, cx, a, b, c };
		}

		it('applies a bare scale key where a Realm has it as a scale, and takes 0.5 for the others', async () => {
			const { a, b, c } = await fixture();

			const { of, result } = await featureScores({ impact: 1 });

			expect(of(a)).toBe(1);
			expect(of(b)).toBe(0.5);
			expect(of(c)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ impact: 2 });
			expect(result.ignored).toEqual([]);
		});

		it('applies attr:member where a Realm has attr as tags with that member, 0.5 for the others', async () => {
			const { a, b, c } = await fixture();

			const { of, result } = await featureScores({ 'area:ui': 1 });

			expect(of(a)).toBe(1);
			expect(of(b)).toBe(0.5);
			expect(of(c)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ 'area:ui': 2 });
		});

		it('reads a bare key as the scale of the one Realm that has it as a scale', async () => {
			const { a, b, c } = await fixture();

			const { of, result } = await featureScores({ area: 1 });

			expect(of(b)).toBe(1);
			expect(of(a)).toBe(0.5);
			expect(of(c)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ area: 2 });
		});

		it('ignores a key that is never a scale (or tags with the member) in the surveyed Realms', async () => {
			const { am, bl, cx } = await fixture();

			expect(
				(await featureScores({ area: 1 }, { realmIds: [am.id, cx.id] })).result.ignored
			).toEqual(['area']);
			expect(
				(await featureScores({ impact: 1 }, { realmIds: [bl.id, cx.id] })).result.ignored
			).toEqual(['impact']);
			expect(
				(await featureScores({ 'area:ui': 1 }, { realmIds: [bl.id, cx.id] })).result.ignored
			).toEqual(['area:ui']);
		});
	});
});
