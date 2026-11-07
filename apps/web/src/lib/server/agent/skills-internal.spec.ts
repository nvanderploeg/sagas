import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { testDb, countStatements, expectFailure } from '#lib/server/test/db.ts';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
});

const code = async (run: () => unknown) => {
	try {
		await run();
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

	it.each(['', 'Vfx', '1vfx', 'vf_x', 'a'.repeat(33)])('refuses the Skill key %j', async (key) => {
		await expectFailure(db.insert(skills).values(row({ key })), /skills_key_format/);
	});

	it('refuses an empty or oversize label and an oversize rubric', async () => {
		await expectFailure(db.insert(skills).values(row({ label: '' })), /skills_label_length/);
		await expectFailure(
			db.insert(skills).values(row({ label: 'x'.repeat(65) })),
			/skills_label_length/
		);
		await expectFailure(
			db.insert(skills).values(row({ rubric: 'x'.repeat(4001) })),
			/skills_rubric_length/
		);
		await db.insert(skills).values(row({ label: 'x'.repeat(64), rubric: 'x'.repeat(4000) }));
	});

	it('refuses a second Skill with the same key', async () => {
		await db.insert(skills).values(row({}));
		await expect(db.insert(skills).values(row({}))).rejects.toThrow();
	});

	it.each([0, 6])('refuses level %s on a held Skill and on a need', async (level) => {
		const { id } = await skill('vfx');
		const l = await labour();
		await expectFailure(
			db
				.insert(userSkills)
				.values({ userId: actor.id, skillId: id, level, setBy: actor.id, via: null, setAt: NOW }),
			/user_skills_level/
		);
		await expectFailure(
			db
				.insert(labourNeeds)
				.values({ labourId: l.id, skillId: id, level, setBy: actor.id, via: null, setAt: NOW }),
			/labour_needs_level/
		);
	});

	it('keeps one row per User and Skill, and per Labour and Skill', async () => {
		const { id } = await skill('vfx');
		const l = await labour();
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
		await db.insert(userSkills).values(held);
		await db.insert(labourNeeds).values(needed);
		await expect(db.insert(userSkills).values(held)).rejects.toThrow();
		await expect(db.insert(labourNeeds).values(needed)).rejects.toThrow();
	});
});

describe('cascades', () => {
	it('deletes a Labour with its needs', async () => {
		const { id } = await skill('vfx');
		const l = await labour();
		await need(l.id, { vfx: 2 });
		expect(await db.select().from(labourNeeds)).toHaveLength(1);
		await deleteLabour(db, actor, l.id);
		expect(await db.select().from(labourNeeds)).toEqual([]);
		expect(await db.select().from(skills).where(eq(skills.id, id))).toHaveLength(1);
	});

	it('deletes a Skill with the levels held and needed', async () => {
		const { id } = await skill('vfx');
		await skill('audio');
		const l = await labour();
		await setSkills(db, actor, actor.id, { vfx: 3, audio: 1 }, NOW);
		await need(l.id, { vfx: 2, audio: 2 });

		await db.delete(skills).where(eq(skills.id, id));

		expect(await db.select().from(userSkills)).toHaveLength(1);
		expect(await db.select().from(labourNeeds)).toHaveLength(1);
	});

	it('refuses to delete a User who holds a Skill or set a need', async () => {
		await skill('vfx');
		const other = await seedUser(db, 'other');
		await setSkills(db, { id: other }, other, { vfx: 3 }, NOW);
		await expectFailure(
			db.delete(users).where(eq(users.id, other)),
			/violates foreign key constraint/
		);
	});
});

describe('needs', () => {
	it('caps a Labour at 8 Skills counted after merging the item', async () => {
		for (const key of keys(9)) await skill(key);
		const l = await labour();
		const eight = Object.fromEntries(keys(NEEDS_MAX).map((key) => [key, 1]));
		await need(l.id, eight);

		await need(l.id, { s0: 5, s1: 2 });
		await need(l.id, { s0: null, s8: 3 });
		expect((await readNeeds(db, l.id)).map((n) => n.key)).toEqual([
			's1',
			's2',
			's3',
			's4',
			's5',
			's6',
			's7',
			's8'
		]);
		expect(await code(() => need(l.id, { s0: 1 }))).toBe('invalid');
		expect(await code(() => need(l.id, { s0: 1, s1: null }))).toBe('none');
		expect(await readNeeds(db, l.id)).toHaveLength(NEEDS_MAX);
	});

	it('refuses the ninth need as invalid and rolls back the whole batch', async () => {
		for (const key of keys(9)) await skill(key);
		const a = await labour();
		const b = await labour();
		await need(b.id, Object.fromEntries(keys(NEEDS_MAX).map((key) => [key, 1])));

		const result = await code(() =>
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
		expect((await readAppraisal(db, a.id)).brief).toBe('');
		expect(await readNeeds(db, a.id)).toEqual([]);
		expect(await readNeeds(db, b.id)).toHaveLength(NEEDS_MAX);
	});

	it('refuses an unknown Skill, a bad level and a repeat as invalid, writing nothing', async () => {
		await skill('vfx');
		const l = await labour();
		for (const needs of <Record<string, number | null>[]>[
			{ vfx: 1, nope: 1 },
			{ vfx: 6 },
			{ vfx: 0 },
			{ vfx: 1.5 },
			{ vfx: '2' as unknown as number },
			{ vfx: 1, VFX: 2 }
		]) {
			expect(await code(() => need(l.id, needs)), JSON.stringify(needs)).toBe('invalid');
		}
		expect(await readNeeds(db, l.id)).toEqual([]);
	});

	it('records setBy and setAt on each written need and rewrites them on a repeat', async () => {
		await skill('vfx');
		const l = await labour();
		const other = await seedUser(db, 'other');
		await appraise(db, actor, [{ labourId: l.id, needs: { vfx: 2 } }], NOW);
		const later = new Date(NOW.getTime() + 1000);
		await appraise(db, { id: other }, [{ labourId: l.id, needs: { vfx: 2 } }], later);
		expect(await readNeeds(db, l.id)).toEqual([
			{ key: 'vfx', level: 2, setBy: other, via: null, setAt: later }
		]);
	});

	it('changes no Realm version, Event, Labour updatedAt or content hash', async () => {
		await skill('vfx');
		const l = await labour();
		const before = {
			hash: await contentHash(db, l.id),
			updatedAt: (await db.select().from(labours).where(eq(labours.id, l.id)).limit(1))[0]!
				.updatedAt,
			events: (await db.select().from(events)).length
		};

		await need(l.id, { vfx: 3 });

		expect(await contentHash(db, l.id)).toBe(before.hash);
		expect(
			(await db.select().from(labours).where(eq(labours.id, l.id)).limit(1))[0]!.updatedAt
		).toEqual(before.updatedAt);
		expect(await db.select().from(events)).toHaveLength(before.events);
		expect(await db.select().from(realmAgent)).toEqual([]);
	});
});

describe('skill_fit loads', () => {
	const load = (candidateIds: number[], forUserId: number) =>
		skillFit.load({
			db,
			candidates: candidateIds.map((id) => ({ id }) as Candidate),
			candidateIds,
			query: undefined,
			forUserId,
			now: NOW
		});

	it('answers for the candidates only', async () => {
		await skill('vfx');
		await setSkills(db, actor, actor.id, { vfx: 2 }, NOW);
		const [a, b, c] = [await labour(), await labour(), await labour()];
		await need(a.id, { vfx: 4 });
		await need(c.id, { vfx: 1 });

		expect(await load([a.id, b.id], actor.id)).toEqual(
			new Map([
				[a.id, 0.5],
				[b.id, null]
			])
		);
	});

	it('answers null for every candidate when the User holds no Skills', async () => {
		await skill('vfx');
		const a = await labour();
		await need(a.id, { vfx: 4 });
		expect(await load([a.id], actor.id)).toEqual(new Map([[a.id, null]]));
	});

	it(
		'reads the User and the needs in two statements however many candidates there are',
		{ timeout: 60_000 },
		async () => {
			await skill('vfx');
			await setSkills(db, actor, actor.id, { vfx: 2 }, NOW);
			const many = await Promise.all(Array.from({ length: 200 }, labour));
			for (const l of many) await need(l.id, { vfx: 3 });
			let fits!: Awaited<ReturnType<typeof load>>;
			const statements = await countStatements(async () => {
				fits = await load(
					many.map((l) => l.id),
					actor.id
				);
			});

			expect(fits.size).toBe(200);
			expect(statements).toBeLessThanOrEqual(2);
		}
	);
});
