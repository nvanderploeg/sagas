import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	events,
	labourNeeds,
	labours,
	realmAgent,
	skills,
	userSkills,
	users
} from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise, readAppraisal } from './appraisals.ts';
import { contentHash } from './content.ts';
import type { Candidate } from './survey/candidates.ts';
import { skillFit } from './survey/features/skill-fit.ts';
import { defineSkill, NEEDS_MAX, readNeeds, setSkills } from './skills.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

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

const code = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		return error instanceof DomainError ? error.code : 'other';
	}
	return 'none';
};

const skill = (key: string) => defineSkill(db, actor, { key, label: key }, NOW);
const labour = () => seedLabour(db, { realmId });
const keys = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);
const need = (labourId: number, needs: Record<string, number | null>) =>
	appraise(db, actor, [{ labourId, needs }], NOW);

describe('schema', () => {
	const row = (over: Partial<typeof skills.$inferInsert>) => ({
		key: 'vfx',
		label: 'VFX',
		rubric: '',
		createdAt: NOW,
		updatedAt: NOW,
		...over
	});

	it.each(['', 'Vfx', '1vfx', 'vf_x', 'a'.repeat(33)])('refuses the Skill key %j', (key) => {
		expect(() => db.insert(skills).values(row({ key })).run()).toThrow(/skills_key_format/);
	});

	it('refuses an empty or oversize label and an oversize rubric', () => {
		expect(() =>
			db
				.insert(skills)
				.values(row({ label: '' }))
				.run()
		).toThrow(/skills_label_length/);
		expect(() =>
			db
				.insert(skills)
				.values(row({ label: 'x'.repeat(65) }))
				.run()
		).toThrow(/skills_label_length/);
		expect(() =>
			db
				.insert(skills)
				.values(row({ rubric: 'x'.repeat(4001) }))
				.run()
		).toThrow(/skills_rubric_length/);
		db.insert(skills)
			.values(row({ label: 'x'.repeat(64), rubric: 'x'.repeat(4000) }))
			.run();
	});

	it('refuses a second Skill with the same key', () => {
		db.insert(skills).values(row({})).run();
		expect(() => db.insert(skills).values(row({})).run()).toThrow();
	});

	it.each([0, 6])('refuses level %s on a held Skill and on a need', (level) => {
		const { id } = skill('vfx');
		const l = labour();
		expect(() =>
			db
				.insert(userSkills)
				.values({ userId: actor.id, skillId: id, level, setBy: actor.id, via: null, setAt: NOW })
				.run()
		).toThrow(/user_skills_level/);
		expect(() =>
			db
				.insert(labourNeeds)
				.values({ labourId: l.id, skillId: id, level, setBy: actor.id, via: null, setAt: NOW })
				.run()
		).toThrow(/labour_needs_level/);
	});

	it('keeps one row per User and Skill, and per Labour and Skill', () => {
		const { id } = skill('vfx');
		const l = labour();
		const held = {
			userId: actor.id,
			skillId: id,
			level: 1,
			setBy: actor.id,
			via: null,
			setAt: NOW
		};
		const needed = {
			labourId: l.id,
			skillId: id,
			level: 1,
			setBy: actor.id,
			via: null,
			setAt: NOW
		};
		db.insert(userSkills).values(held).run();
		db.insert(labourNeeds).values(needed).run();
		expect(() => db.insert(userSkills).values(held).run()).toThrow();
		expect(() => db.insert(labourNeeds).values(needed).run()).toThrow();
	});
});

describe('cascades', () => {
	it('deletes a Labour with its needs', () => {
		const { id } = skill('vfx');
		const l = labour();
		need(l.id, { vfx: 2 });
		expect(db.select().from(labourNeeds).all()).toHaveLength(1);
		deleteLabour(db, actor, l.id);
		expect(db.select().from(labourNeeds).all()).toEqual([]);
		expect(db.select().from(skills).where(eq(skills.id, id)).all()).toHaveLength(1);
	});

	it('deletes a Skill with the levels held and needed', () => {
		const { id } = skill('vfx');
		skill('audio');
		const l = labour();
		setSkills(db, actor, actor.id, { vfx: 3, audio: 1 }, NOW);
		need(l.id, { vfx: 2, audio: 2 });

		db.delete(skills).where(eq(skills.id, id)).run();

		expect(db.select().from(userSkills).all()).toHaveLength(1);
		expect(db.select().from(labourNeeds).all()).toHaveLength(1);
	});

	it('refuses to delete a User who holds a Skill or set a need', () => {
		skill('vfx');
		const other = seedUser(db, 'other');
		setSkills(db, { id: other }, other, { vfx: 3 }, NOW);
		expect(() => db.delete(users).where(eq(users.id, other)).run()).toThrow(/FOREIGN KEY/);
	});
});

describe('needs', () => {
	it('caps a Labour at 8 Skills counted after merging the item', () => {
		keys(9).forEach(skill);
		const l = labour();
		const eight = Object.fromEntries(keys(NEEDS_MAX).map((key) => [key, 1]));
		need(l.id, eight);

		need(l.id, { s0: 5, s1: 2 });
		need(l.id, { s0: null, s8: 3 });
		expect(readNeeds(db, l.id).map((n) => n.key)).toEqual([
			's1',
			's2',
			's3',
			's4',
			's5',
			's6',
			's7',
			's8'
		]);
		expect(code(() => need(l.id, { s0: 1 }))).toBe('invalid');
		expect(code(() => need(l.id, { s0: 1, s1: null }))).toBe('none');
		expect(readNeeds(db, l.id)).toHaveLength(NEEDS_MAX);
	});

	it('refuses the ninth need as invalid and rolls back the whole batch', () => {
		keys(9).forEach(skill);
		const a = labour();
		const b = labour();
		need(b.id, Object.fromEntries(keys(NEEDS_MAX).map((key) => [key, 1])));

		const result = code(() =>
			appraise(
				db,
				actor,
				[
					{ labourId: a.id, brief: 'kept?', needs: { s0: 2 } },
					{ labourId: b.id, needs: { s8: 1 } }
				],
				NOW
			)
		);

		expect(result).toBe('invalid');
		expect(readAppraisal(db, a.id).brief).toBe('');
		expect(readNeeds(db, a.id)).toEqual([]);
		expect(readNeeds(db, b.id)).toHaveLength(NEEDS_MAX);
	});

	it('refuses an unknown Skill, a bad level and a repeat as invalid, writing nothing', () => {
		skill('vfx');
		const l = labour();
		for (const needs of <Record<string, number | null>[]>[
			{ vfx: 1, nope: 1 },
			{ vfx: 6 },
			{ vfx: 0 },
			{ vfx: 1.5 },
			{ vfx: '2' as unknown as number },
			{ vfx: 1, VFX: 2 }
		]) {
			expect(
				code(() => need(l.id, needs)),
				JSON.stringify(needs)
			).toBe('invalid');
		}
		expect(readNeeds(db, l.id)).toEqual([]);
	});

	it('records setBy and setAt on each written need and rewrites them on a repeat', () => {
		skill('vfx');
		const l = labour();
		const other = seedUser(db, 'other');
		appraise(db, actor, [{ labourId: l.id, needs: { vfx: 2 } }], NOW);
		const later = new Date(NOW.getTime() + 1000);
		appraise(db, { id: other }, [{ labourId: l.id, needs: { vfx: 2 } }], later);
		expect(readNeeds(db, l.id)).toEqual([
			{ key: 'vfx', level: 2, setBy: other, via: null, setAt: later }
		]);
	});

	it('changes no Realm version, Event, Labour updatedAt or content hash', () => {
		skill('vfx');
		const l = labour();
		const before = {
			hash: contentHash(db, l.id),
			updatedAt: db.select().from(labours).where(eq(labours.id, l.id)).get()!.updatedAt,
			events: db.select().from(events).all().length
		};

		need(l.id, { vfx: 3 });

		expect(contentHash(db, l.id)).toBe(before.hash);
		expect(db.select().from(labours).where(eq(labours.id, l.id)).get()!.updatedAt).toEqual(
			before.updatedAt
		);
		expect(db.select().from(events).all()).toHaveLength(before.events);
		expect(db.select().from(realmAgent).all()).toEqual([]);
	});
});

describe('skill_fit loads', () => {
	const load = (candidateIds: number[], forUserId: number) =>
		skillFit.load({
			db,
			candidates: candidateIds.map((id) => ({ id }) as Candidate),
			candidateIds: JSON.stringify(candidateIds),
			query: undefined,
			forUserId,
			now: NOW
		});

	it('answers for the candidates only', () => {
		skill('vfx');
		setSkills(db, actor, actor.id, { vfx: 2 }, NOW);
		const [a, b, c] = [labour(), labour(), labour()];
		need(a.id, { vfx: 4 });
		need(c.id, { vfx: 1 });

		expect(load([a.id, b.id], actor.id)).toEqual(
			new Map([
				[a.id, 0.5],
				[b.id, null]
			])
		);
	});

	it('answers null for every candidate when the User holds no Skills', () => {
		skill('vfx');
		const a = labour();
		need(a.id, { vfx: 4 });
		expect(load([a.id], actor.id)).toEqual(new Map([[a.id, null]]));
	});

	it('reads the User and the needs in two statements however many candidates there are', () => {
		skill('vfx');
		setSkills(db, actor, actor.id, { vfx: 2 }, NOW);
		const many = Array.from({ length: 200 }, labour);
		many.forEach((l) => need(l.id, { vfx: 3 }));
		const prepare = vi.spyOn(db.$client, 'prepare');

		const fits = load(
			many.map((l) => l.id),
			actor.id
		);

		expect(fits.size).toBe(200);
		expect(prepare.mock.calls.length).toBeLessThanOrEqual(2);
	});
});
