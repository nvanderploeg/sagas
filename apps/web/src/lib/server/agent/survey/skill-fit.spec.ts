import { generateNKeysBetween } from 'fractional-indexing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { defineSkill, setSkills } from '#lib/server/agent/skills.ts';
import { FEATURES, LATER_FEATURES } from '#lib/server/agent/survey/features/index.ts';
import { survey, type SurveyInput } from '#lib/server/agent/survey/index.ts';
import type { Db } from '#lib/server/db/client.ts';
import { labourKeys, labourNeeds, labours, skills } from '#lib/server/db/schema.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { listStates } from '#lib/server/domain/states.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { budget } from '#lib/server/test/budget.ts';

let db: Db;
let actor: Actor;
let bob: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	bob = { id: seedUser(db, 'bob') };
});

afterEach(() => {
	db.$client.close();
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');

function run(weights: Record<string, number>, extra: Partial<SurveyInput> = {}) {
	return survey(db, actor, { weights, temperature: 0, limit: 50, ...extra }, { now: NOW });
}

const FIT = { skill_fit: 1 };

function skill(key: string) {
	defineSkill(db, actor, { key, label: key }, NOW);
}

const hold = (userId: number, levels: Record<string, number | null>) =>
	setSkills(db, actor, userId, levels, NOW);

const needs = (labourId: number, levels: Record<string, number | null>) =>
	appraise(db, actor, [{ labourId, needs: levels }], NOW);

function scoreOf(result: ReturnType<typeof run>, labour: { id: number }) {
	const item = result.results.find((r) => r.labourId === labour.id);
	if (item === undefined) throw new Error(`Labour ${labour.id} is not in the results`);
	return item;
}

describe('skill_fit registration', () => {
	it('is a built-in feature and no longer a later one', () => {
		expect(Object.keys(FEATURES)).toContain('skill_fit');
		expect(FEATURES.skill_fit.name).toBe('skill_fit');
		expect(LATER_FEATURES).not.toContain('skill_fit');
	});

	it('is applied as a weight, not reported in `ignored`', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });

		expect(run(FIT).ignored).toEqual([]);
	});
});

describe('skill_fit', () => {
	beforeEach(() => {
		for (const key of ['vfx', 'combat-design', 'audio']) skill(key);
	});

	it('is the mean over the needed Skills of min(1, held / needed)', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 4, 'combat-design': 2 });
		const both = seedLabour(db, { realmId: realm.id, title: 'both' });
		needs(both.id, { vfx: 4, 'combat-design': 4 });
		const partlyLacking = seedLabour(db, { realmId: realm.id, title: 'lacks audio' });
		needs(partlyLacking.id, { vfx: 5, audio: 2, 'combat-design': 1 });
		const mixed = seedLabour(db, { realmId: realm.id, title: 'over and under' });
		needs(mixed.id, { vfx: 1, 'combat-design': 5 });
		const single = seedLabour(db, { realmId: realm.id, title: 'one skill' });
		needs(single.id, { vfx: 5 });

		const result = run(FIT);

		// (4/4 + 2/4) / 2
		expect(scoreOf(result, both).score).toBeCloseTo(0.75, 10);
		// (4/5 + 0 + 1) / 3
		expect(scoreOf(result, partlyLacking).score).toBeCloseTo(0.6, 10);
		// (1 + 2/5) / 2
		expect(scoreOf(result, mixed).score).toBeCloseTo(0.7, 10);
		expect(scoreOf(result, single).score).toBeCloseTo(0.8, 10);
		expect(result.coverage.missing).toEqual({});
	});

	it('scales the score by the weight and reports weight times feature as the contribution', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 3 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { vfx: 4 });

		const item = scoreOf(run({ skill_fit: 4 }), labour);

		expect(item.score).toBeCloseTo(3, 10);
		expect(item.contributions.skill_fit).toBeCloseTo(3, 10);
	});

	it('caps an over-qualified User at 1 for that Skill, so it cannot lift a Skill they lack', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const exact = seedLabour(db, { realmId: realm.id, title: 'needs one' });
		needs(exact.id, { vfx: 1 });
		const withGap = seedLabour(db, { realmId: realm.id, title: 'needs one and audio' });
		needs(withGap.id, { vfx: 1, audio: 3 });

		const result = run(FIT);

		expect(scoreOf(result, exact).score).toBeCloseTo(1, 10);
		// Uncapped, 5/1 would make this (5 + 0) / 2.
		expect(scoreOf(result, withGap).score).toBeCloseTo(0.5, 10);
	});

	it('scores 0, not missing, for a Labour that needs only Skills the User lacks', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { audio: 3, 'combat-design': 1 });

		const result = run(FIT);

		expect(scoreOf(result, labour).score).toBe(0);
		expect(scoreOf(result, labour).contributions).not.toHaveProperty('skill_fit');
		expect(result.coverage.missing).not.toHaveProperty('skill_fit');
	});

	it('takes 0.5 and counts as missing a Labour that needs no Skills', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const bare = seedLabour(db, { realmId: realm.id, title: 'bare' });
		const other = seedLabour(db, { realmId: realm.id, title: 'other bare' });
		const needy = seedLabour(db, { realmId: realm.id, title: 'needy' });
		needs(needy.id, { vfx: 5 });

		const result = run(FIT);

		expect(scoreOf(result, bare).score).toBeCloseTo(0.5, 10);
		expect(scoreOf(result, other).score).toBeCloseTo(0.5, 10);
		expect(scoreOf(result, needy).score).toBeCloseTo(1, 10);
		expect(result.coverage.missing).toEqual({ skill_fit: 2 });
	});

	it('takes 0.5 times the weight for a missing Labour', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const bare = seedLabour(db, { realmId: realm.id });

		const item = scoreOf(run({ skill_fit: 3 }), bare);

		expect(item.score).toBeCloseTo(1.5, 10);
		expect(item.contributions.skill_fit).toBeCloseTo(1.5, 10);
	});

	it('takes 0.5 for every candidate, and counts each once, when the User holds no Skills at all', () => {
		const realm = seedRealm(db, 'AM');
		const needy = seedLabour(db, { realmId: realm.id, title: 'needs vfx' });
		needs(needy.id, { vfx: 1 });
		const bare = seedLabour(db, { realmId: realm.id, title: 'needs nothing' });
		const third = seedLabour(db, { realmId: realm.id, title: 'needs two' });
		needs(third.id, { vfx: 3, audio: 2 });

		const result = run(FIT);

		for (const labour of [needy, bare, third]) {
			expect(scoreOf(result, labour).score, labour.title).toBeCloseTo(0.5, 10);
		}
		expect(result.coverage.missing).toEqual({ skill_fit: 3 });
	});

	it('treats a User who cleared every Skill as holding none', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		hold(actor.id, { vfx: null });
		const needy = seedLabour(db, { realmId: realm.id });
		needs(needy.id, { vfx: 5 });

		const result = run(FIT);

		expect(scoreOf(result, needy).score).toBeCloseTo(0.5, 10);
		expect(result.coverage.missing).toEqual({ skill_fit: 1 });
	});

	it('does not list skill_fit under missing when no candidate is missing', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 2 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { vfx: 2 });

		expect(run(FIT).coverage.missing).toEqual({});
	});

	it('is computed across Realms, since a Skill is named once for the instance', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		hold(actor.id, { vfx: 2 });
		const inAm = seedLabour(db, { realmId: am.id });
		needs(inAm.id, { vfx: 4 });
		const inBl = seedLabour(db, { realmId: bl.id });
		needs(inBl.id, { vfx: 1 });

		const result = run(FIT);

		expect(scoreOf(result, inAm).score).toBeCloseTo(0.5, 10);
		expect(scoreOf(result, inBl).score).toBeCloseTo(1, 10);
	});

	it('follows a need that was changed or cleared', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 2, audio: 4 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { vfx: 4, audio: 4 });
		expect(scoreOf(run(FIT), labour).score).toBeCloseTo(0.75, 10);

		needs(labour.id, { vfx: 2 });
		expect(scoreOf(run(FIT), labour).score).toBeCloseTo(1, 10);

		needs(labour.id, { vfx: null, audio: null });
		const cleared = run(FIT);
		expect(scoreOf(cleared, labour).score).toBeCloseTo(0.5, 10);
		expect(cleared.coverage.missing).toEqual({ skill_fit: 1 });
	});

	it('puts the Labours the User can do ahead of the ones they cannot', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const audio = seedLabour(db, { realmId: realm.id, title: 'audio' });
		needs(audio.id, { audio: 4 });
		const effects = seedLabour(db, { realmId: realm.id, title: 'effects' });
		needs(effects.id, { vfx: 3 });
		const bare = seedLabour(db, { realmId: realm.id, title: 'bare' });

		const result = run(FIT);

		expect(result.results.map((r) => r.labourId)).toEqual([effects.id, bare.id, audio.id]);
	});
});

describe('skill_fit for a User', () => {
	beforeEach(() => {
		for (const key of ['vfx', 'combat-design']) skill(key);
	});

	function fixture() {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		hold(bob.id, { vfx: 1, 'combat-design': 4 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { vfx: 5 });
		const combat = seedLabour(db, { realmId: realm.id, title: 'combat' });
		needs(combat.id, { 'combat-design': 4 });
		return { labour, combat };
	}

	it('uses the asking User when no other User is named', () => {
		const { labour, combat } = fixture();

		const result = run(FIT);

		expect(scoreOf(result, labour).score).toBeCloseTo(1, 10);
		expect(scoreOf(result, combat).score).toBe(0);
	});

	it('uses the Survey User, not the actor, when `forUserId` names someone else', () => {
		const { labour, combat } = fixture();

		const result = run(FIT, { forUserId: bob.id });

		expect(scoreOf(result, labour).score).toBeCloseTo(0.2, 10);
		expect(scoreOf(result, combat).score).toBeCloseTo(1, 10);
	});

	it('counts missing against the Survey User: the actor holds Skills but the named User holds none', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { vfx: 5 });
		const nobody = { id: seedUser(db, 'nobody') };

		const asNobody = run(FIT, { forUserId: nobody.id });

		expect(scoreOf(asNobody, labour).score).toBeCloseTo(0.5, 10);
		expect(asNobody.coverage.missing).toEqual({ skill_fit: 1 });
		expect(run(FIT).coverage.missing).toEqual({});
	});

	it('uses the Skills of whoever asks: Bob asking is scored on Bob, not on the other actor', () => {
		const realm = seedRealm(db, 'AM');
		hold(bob.id, { vfx: 5 });
		const labour = seedLabour(db, { realmId: realm.id });
		needs(labour.id, { vfx: 5 });

		const asBob = survey(db, bob, { weights: FIT, temperature: 0, limit: 50 }, { now: NOW });

		expect(scoreOf(asBob, labour).score).toBeCloseTo(1, 10);
		expect(scoreOf(run(FIT), labour).score).toBeCloseTo(0.5, 10);
	});
});

describe('skill_fit with another weight', () => {
	beforeEach(() => {
		skill('vfx');
	});

	it('adds weight times feature for each, and lets a better fit outrank a better age', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 4 });
		const old = seedLabour(db, { realmId: realm.id, title: 'old, no needs' });
		db.update(labours)
			.set({ createdAt: new Date(NOW.getTime() - 30 * DAY) })
			.where(eq(labours.id, old.id))
			.run();
		const fresh = seedLabour(db, { realmId: realm.id, title: 'fresh, fits' });
		db.update(labours).set({ createdAt: NOW }).where(eq(labours.id, fresh.id)).run();
		needs(fresh.id, { vfx: 2 });

		const result = run({ skill_fit: 3, age: 1 });

		// age at 30 days is 30 / (30 + 30) = 0.5; the Labour with no needs is missing, 0.5.
		expect(scoreOf(result, old).score).toBeCloseTo(3 * 0.5 + 0.5, 10);
		expect(scoreOf(result, fresh).score).toBeCloseTo(3 * 1 + 0, 10);
		expect(result.results.map((r) => r.labourId)).toEqual([fresh.id, old.id]);
		expect(scoreOf(result, fresh).contributions).toEqual({ skill_fit: 3 });
		expect(Object.keys(scoreOf(result, old).contributions)).toEqual(['skill_fit', 'age']);
		expect(result.coverage.missing).toEqual({ skill_fit: 1 });
	});

	it('lets a negative skill_fit weight push the best fit down', () => {
		const realm = seedRealm(db, 'AM');
		hold(actor.id, { vfx: 5 });
		const fits = seedLabour(db, { realmId: realm.id, title: 'fits' });
		needs(fits.id, { vfx: 1 });
		const stretch = seedLabour(db, { realmId: realm.id, title: 'stretch' });
		skill('audio');
		needs(stretch.id, { audio: 3 });

		const result = run({ skill_fit: -2 });

		expect(scoreOf(result, fits).score).toBeCloseTo(-2, 10);
		expect(result.results.map((r) => r.labourId)).toEqual([stretch.id, fits.id]);
	});
});

describe('skill_fit performance', () => {
	it('scores 5,000 candidates, each with needs, in under 200 ms', () => {
		const realm = seedRealm(db, 'AM');
		const owner = seedUser(db, 'owner');
		const todo = listStates(db, realm.id).find((s) => s.key === 'todo')!;
		const count = 5000;
		const ranks = generateNKeysBetween(null, null, count);
		const rows = Array.from({ length: count }, (_, i) => ({
			realmId: realm.id,
			number: i + 1,
			title: `Labour ${i + 1}`,
			description: '',
			ownerId: owner,
			stateId: todo.id,
			rank: ranks[i],
			labels: [] as string[],
			createdAt: NOW,
			updatedAt: NOW
		}));
		const skillKeys = ['vfx', 'audio', 'combat-design', 'ui', 'level-design', 'narrative'];
		for (const key of skillKeys) skill(key);
		hold(actor.id, { vfx: 4, audio: 2, 'combat-design': 5 });
		const skillIds = db.select({ id: skills.id }).from(skills).orderBy(skills.key).all();

		db.transaction((tx) => {
			for (let i = 0; i < rows.length; i += 500)
				tx.insert(labours)
					.values(rows.slice(i, i + 500))
					.run();
		});
		const ids = db.select({ id: labours.id }).from(labours).orderBy(labours.id).all();
		db.transaction((tx) => {
			const keys = ids.map((row, i) => ({ key: `AM-${i + 1}`, labourId: row.id }));
			for (let i = 0; i < keys.length; i += 500) {
				tx.insert(labourKeys)
					.values(keys.slice(i, i + 500))
					.run();
			}
			const wanted = ids.flatMap((row, i) =>
				[0, 1, 2].map((offset) => ({
					labourId: row.id,
					skillId: skillIds[(i + offset) % skillIds.length].id,
					level: 1 + ((i + offset) % 5),
					setBy: actor.id,
					setAt: NOW
				}))
			);
			for (let i = 0; i < wanted.length; i += 500) {
				tx.insert(labourNeeds)
					.values(wanted.slice(i, i + 500))
					.run();
			}
		});
		db.$client.prepare('UPDATE realms SET labour_counter = ? WHERE id = ?').run(count, realm.id);

		const times: number[] = [];
		const first = run(FIT, { limit: 15 });
		for (let i = 0; i < 3; i++) {
			const start = performance.now();
			run(FIT, { limit: 15 });
			times.push(performance.now() - start);
		}

		expect(first.coverage.candidates).toBe(count);
		expect(first.coverage.missing).toEqual({});
		expect(first.results).toHaveLength(15);
		expect(first.results[0].score).toBeGreaterThanOrEqual(first.results[14].score);
		expect(times.sort((a, b) => a - b)[1]).toBeLessThan(budget(200));
	}, 120_000);
});
