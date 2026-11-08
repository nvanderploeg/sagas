import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labourNeeds, labours, skills, userSkills } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb, expectResolves } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise, readAppraisal } from './appraisals.ts';
import { defineAttribute, readRealmAgent, setValues } from './attributes.ts';
import { contentHash } from './content.ts';
import { defineSkill, listSkills, readUserSkills, setSkills } from './skills.ts';

let db: Db;
let actor: Actor;
let other: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	other = { id: await seedUser(db, 'other') };
});

const day = (n: number) => new Date(Date.UTC(2030, 0, n));

async function expectDomainError(
	action: () => unknown,
	code: DomainError['code']
): Promise<DomainError> {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	return thrown as DomainError;
}

const define = (key: string, label = key, rubric?: string, now = day(1)) =>
	defineSkill(db, actor, { key, label, rubric }, now);

const skillCount = async () => (await db.select().from(skills)).length;

describe('defineSkill', () => {
	it('creates a Skill with the given label and an empty rubric, stamped with now', async () => {
		const view = await defineSkill(db, actor, { key: 'vfx', label: 'Visual effects' }, day(1));

		expect(view).toEqual({
			id: expect.any(Number),
			key: 'vfx',
			label: 'Visual effects',
			rubric: '',
			createdAt: day(1),
			updatedAt: day(1)
		});
		expect(await db.select().from(skills)).toHaveLength(1);
	});

	it('creates a Skill with a rubric', async () => {
		const view = await defineSkill(
			db,
			actor,
			{ key: 'vfx', label: 'Visual effects', rubric: '1 = tweaks, 5 = owns the pipeline' },
			day(1)
		);

		expect(view.rubric).toBe('1 = tweaks, 5 = owns the pipeline');
	});

	it('trims and lowercases the key, and trims the label and the rubric', async () => {
		const view = await defineSkill(
			db,
			actor,
			{ key: '  VFX ', label: '  Visual effects  ', rubric: '  how good  ' },
			day(1)
		);

		expect(view).toMatchObject({ key: 'vfx', label: 'Visual effects', rubric: 'how good' });
	});

	it('accepts keys of 1 to 32 characters made of lowercase letters, digits and hyphens, starting with a letter', async () => {
		for (const key of ['a', 'a1', 'combat-design', 'a-', 'a'.repeat(32)]) {
			expect((await define(key)).key, key).toBe(key);
		}
	});

	it('refuses a malformed key as invalid, creating nothing', async () => {
		for (const key of [
			'',
			'   ',
			'1vfx',
			'-vfx',
			'vfx_fx',
			'vf x',
			'vfx!',
			'vfx.fx',
			'é',
			'a'.repeat(33)
		]) {
			await expectDomainError(() => define(key, 'Label'), 'invalid');
		}

		expect(await skillCount()).toBe(0);
	});

	it('names no reserved words: Attribute and Survey names are fine as Skill keys', async () => {
		for (const key of ['rank', 'priority', 'keywords', 'age']) {
			expect((await define(key)).key, key).toBe(key);
		}
	});

	it('requires a label when the key is new', async () => {
		await expectDomainError(() => defineSkill(db, actor, { key: 'vfx' }, day(1)), 'invalid');
		await expectDomainError(
			() => defineSkill(db, actor, { key: 'vfx', rubric: 'r' }, day(1)),
			'invalid'
		);

		expect(await skillCount()).toBe(0);
	});

	it('refuses a label that is empty after trimming or longer than 64 characters', async () => {
		await expectDomainError(() => define('vfx', ''), 'invalid');
		await expectDomainError(() => define('vfx', '   '), 'invalid');
		await expectDomainError(() => define('vfx', 'x'.repeat(65)), 'invalid');
		expect(await skillCount()).toBe(0);

		expect((await define('vfx', 'x'.repeat(64))).label).toHaveLength(64);
	});

	it('counts the label length after trimming', async () => {
		expect((await define('vfx', ` ${'x'.repeat(64)} `)).label).toHaveLength(64);
	});

	it('accepts a rubric of 4,000 characters and refuses one of 4,001', async () => {
		await expectDomainError(() => define('vfx', 'VFX', 'r'.repeat(4001)), 'invalid');
		expect(await skillCount()).toBe(0);

		expect((await define('vfx', 'VFX', 'r'.repeat(4000))).rubric).toHaveLength(4000);
	});

	it('stores an empty or whitespace-only rubric as an empty string', async () => {
		expect((await define('vfx', 'VFX', '   ')).rubric).toBe('');
	});

	describe('revising an existing Skill', () => {
		it('changes only the label, leaving the rubric and createdAt alone, and moves updatedAt', async () => {
			const created = await define('vfx', 'VFX', 'the rubric', day(1));

			const revised = await defineSkill(db, actor, { key: 'vfx', label: 'Visual effects' }, day(2));

			expect(revised).toEqual({
				id: created.id,
				key: 'vfx',
				label: 'Visual effects',
				rubric: 'the rubric',
				createdAt: day(1),
				updatedAt: day(2)
			});
			expect(await skillCount()).toBe(1);
		});

		it('changes only the rubric, leaving the label alone, and moves updatedAt', async () => {
			await define('vfx', 'Visual effects', 'old', day(1));

			const revised = await defineSkill(db, actor, { key: 'vfx', rubric: 'new' }, day(3));

			expect(revised).toMatchObject({ label: 'Visual effects', rubric: 'new', updatedAt: day(3) });
		});

		it('clears the rubric with an empty string', async () => {
			await define('vfx', 'VFX', 'old', day(1));

			const revised = await defineSkill(db, actor, { key: 'vfx', rubric: '' }, day(2));

			expect(revised.rubric).toBe('');
			expect(revised.updatedAt).toEqual(day(2));
		});

		it('matches the key after trimming and lowercasing, so it revises rather than creates', async () => {
			const created = await define('vfx', 'VFX', '', day(1));

			const revised = await defineSkill(db, actor, { key: ' VfX ', label: 'Effects' }, day(2));

			expect(revised).toMatchObject({ id: created.id, key: 'vfx', label: 'Effects' });
			expect(await skillCount()).toBe(1);
		});

		it('does not require a label', async () => {
			await define('vfx', 'VFX', 'old', day(1));

			await expectResolves(defineSkill(db, actor, { key: 'vfx', rubric: 'new' }, day(2)));
		});

		it('leaves updatedAt alone when the given fields already match', async () => {
			const created = await define('vfx', 'VFX', 'rubric', day(1));

			const same = await defineSkill(
				db,
				actor,
				{ key: 'vfx', label: 'VFX', rubric: 'rubric' },
				day(5)
			);

			expect(same).toEqual(created);
			expect((await db.select().from(skills).limit(1))[0]!.updatedAt).toEqual(day(1));
		});

		it('leaves updatedAt alone when only the key is given', async () => {
			const created = await define('vfx', 'VFX', 'rubric', day(1));

			expect(await defineSkill(db, actor, { key: 'vfx' }, day(5))).toEqual(created);
		});

		it('compares trimmed values, so a padded label that matches is no change', async () => {
			const created = await define('vfx', 'VFX', 'rubric', day(1));

			const same = await defineSkill(
				db,
				actor,
				{ key: 'vfx', label: '  VFX ', rubric: ' rubric ' },
				day(5)
			);

			expect(same.updatedAt).toEqual(created.updatedAt);
		});

		it('refuses an empty or over-long label and an over-long rubric, changing nothing', async () => {
			await define('vfx', 'VFX', 'rubric', day(1));

			await expectDomainError(
				() => defineSkill(db, actor, { key: 'vfx', label: '  ' }, day(2)),
				'invalid'
			);
			await expectDomainError(
				() => defineSkill(db, actor, { key: 'vfx', label: 'x'.repeat(65) }, day(2)),
				'invalid'
			);
			await expectDomainError(
				() => defineSkill(db, actor, { key: 'vfx', rubric: 'r'.repeat(4001) }, day(2)),
				'invalid'
			);

			expect((await db.select().from(skills).limit(1))[0]).toMatchObject({
				label: 'VFX',
				rubric: 'rubric',
				updatedAt: day(1)
			});
		});

		it('a refused revise does not apply the valid field that came with the bad one', async () => {
			await define('vfx', 'VFX', 'rubric', day(1));

			await expectDomainError(
				() =>
					defineSkill(
						db,
						actor,
						{ key: 'vfx', label: 'Changed', rubric: 'r'.repeat(4001) },
						day(2)
					),
				'invalid'
			);

			expect((await db.select().from(skills).limit(1))[0]).toMatchObject({
				label: 'VFX',
				updatedAt: day(1)
			});
		});
	});
});

describe('listSkills', () => {
	it('is empty when no Skill is defined', async () => {
		expect(await listSkills(db)).toEqual([]);
	});

	it('lists every Skill by key, whatever order they were created in', async () => {
		await define('vfx', 'VFX');
		await define('combat-design', 'Combat design');
		await define('audio', 'Audio');

		expect((await listSkills(db)).map((s) => s.key)).toEqual(['audio', 'combat-design', 'vfx']);
	});

	it('carries the full view of each Skill with its holders', async () => {
		const created = await define('vfx', 'Visual effects', 'rubric', day(1));

		expect(await listSkills(db)).toEqual([{ ...created, holders: 0 }]);
	});

	it('counts the Users who hold each Skill, and counts 0 for a Skill nobody holds', async () => {
		await define('audio');
		await define('combat-design');
		await define('vfx');
		await setSkills(db, actor, actor.id, { vfx: 3, audio: 1 }, day(2));
		await setSkills(db, actor, other.id, { vfx: 5 }, day(2));

		const holders = Object.fromEntries((await listSkills(db)).map((s) => [s.key, s.holders]));

		expect(holders).toEqual({ audio: 1, 'combat-design': 0, vfx: 2 });
	});

	it('stops counting a User who cleared the Skill', async () => {
		await define('vfx');
		await setSkills(db, actor, actor.id, { vfx: 3 }, day(2));
		await setSkills(db, actor, other.id, { vfx: 3 }, day(2));

		await setSkills(db, actor, other.id, { vfx: null }, day(3));

		expect((await listSkills(db))[0].holders).toBe(1);
	});
});

describe('setSkills', () => {
	beforeEach(async () => {
		await define('vfx', 'VFX');
		await define('combat-design', 'Combat design');
		await define('audio', 'Audio');
	});

	const rowsOf = async (userId: number) =>
		await db
			.select({
				key: skills.key,
				level: userSkills.level,
				setBy: userSkills.setBy,
				via: userSkills.via,
				setAt: userSkills.setAt
			})
			.from(userSkills)
			.innerJoin(skills, eq(skills.id, userSkills.skillId))
			.where(eq(userSkills.userId, userId))
			.orderBy(skills.key);

	it('sets the named levels and returns the whole set', async () => {
		const result = await setSkills(db, actor, actor.id, { vfx: 4, 'combat-design': 2 }, day(2));

		expect(result).toEqual({ vfx: 4, 'combat-design': 2 });
		expect(await readUserSkills(db, actor.id)).toEqual({ vfx: 4, 'combat-design': 2 });
	});

	it('accepts every level from 1 to 5', async () => {
		for (const level of [1, 2, 3, 4, 5]) {
			expect(await setSkills(db, actor, actor.id, { vfx: level }, day(2)), String(level)).toEqual({
				vfx: level
			});
		}
	});

	it('merges: Skills not named keep their level, setBy and setAt', async () => {
		await setSkills(db, other, actor.id, { vfx: 4 }, day(2));

		const result = await setSkills(db, actor, actor.id, { audio: 2 }, day(3));

		expect(result).toEqual({ vfx: 4, audio: 2 });
		expect(await rowsOf(actor.id)).toEqual([
			{ key: 'audio', level: 2, setBy: actor.id, via: null, setAt: day(3) },
			{ key: 'vfx', level: 4, setBy: other.id, via: null, setAt: day(2) }
		]);
	});

	it('changes a level, rewriting setBy and setAt', async () => {
		await setSkills(db, actor, actor.id, { vfx: 2 }, day(2));

		const result = await setSkills(db, other, actor.id, { vfx: 5 }, day(4));

		expect(result).toEqual({ vfx: 5 });
		expect(await rowsOf(actor.id)).toEqual([
			{ key: 'vfx', level: 5, setBy: other.id, via: null, setAt: day(4) }
		]);
	});

	it('records the actor as setBy and now as setAt on each written row', async () => {
		await setSkills(db, actor, other.id, { vfx: 3, audio: 1 }, day(7));

		expect(await rowsOf(other.id)).toEqual([
			{ key: 'audio', level: 1, setBy: actor.id, via: null, setAt: day(7) },
			{ key: 'vfx', level: 3, setBy: actor.id, via: null, setAt: day(7) }
		]);
	});

	it('clears a Skill with null, leaves the others, and returns the rest', async () => {
		await setSkills(db, actor, actor.id, { vfx: 4, audio: 2, 'combat-design': 1 }, day(2));

		const result = await setSkills(db, actor, actor.id, { audio: null }, day(3));

		expect(result).toEqual({ vfx: 4, 'combat-design': 1 });
		expect((await rowsOf(actor.id)).map((r) => r.key)).toEqual(['combat-design', 'vfx']);
	});

	it('clears and sets in one call', async () => {
		await setSkills(db, actor, actor.id, { vfx: 4, audio: 2 }, day(2));

		const result = await setSkills(
			db,
			actor,
			actor.id,
			{ audio: null, 'combat-design': 3 },
			day(3)
		);

		expect(result).toEqual({ vfx: 4, 'combat-design': 3 });
	});

	it('clearing every Skill leaves an empty set', async () => {
		await setSkills(db, actor, actor.id, { vfx: 4, audio: 2 }, day(2));

		const result = await setSkills(db, actor, actor.id, { vfx: null, audio: null }, day(3));

		expect(result).toEqual({});
		expect(await rowsOf(actor.id)).toEqual([]);
	});

	it('keeps each User own set apart', async () => {
		await setSkills(db, actor, actor.id, { vfx: 4 }, day(2));
		await setSkills(db, actor, other.id, { audio: 2 }, day(2));

		expect(await readUserSkills(db, actor.id)).toEqual({ vfx: 4 });
		expect(await readUserSkills(db, other.id)).toEqual({ audio: 2 });
	});

	it('lets any User set any Users Skills, not only their own', async () => {
		const byOther = await setSkills(db, other, actor.id, { vfx: 3 }, day(2));
		const byActor = await setSkills(db, actor, other.id, { audio: 5 }, day(2));

		expect(byOther).toEqual({ vfx: 3 });
		expect(byActor).toEqual({ audio: 5 });
	});

	it('returns an empty set for a User with no Skills', async () => {
		expect(await readUserSkills(db, actor.id)).toEqual({});
	});

	describe('refusals', () => {
		it('refuses an unknown Skill key as invalid', async () => {
			await expectDomainError(() => setSkills(db, actor, actor.id, { nope: 3 }, day(2)), 'invalid');
		});

		it('refuses an unknown Skill key even when the value is null', async () => {
			await expectDomainError(
				() => setSkills(db, actor, actor.id, { nope: null }, day(2)),
				'invalid'
			);
		});

		it.each([0, 6, -1, 2.5, 100, Number.NaN, Number.POSITIVE_INFINITY])(
			'refuses level %s as invalid',
			async (level) => {
				await expectDomainError(
					() => setSkills(db, actor, actor.id, { vfx: level }, day(2)),
					'invalid'
				);
				expect(await rowsOf(actor.id)).toEqual([]);
			}
		);

		it('refuses a level that is not a number', async () => {
			for (const level of ['3', true, {}, [3]]) {
				await expectDomainError(
					() => setSkills(db, actor, actor.id, { vfx: level as unknown as number }, day(2)),
					'invalid'
				);
			}
			expect(await rowsOf(actor.id)).toEqual([]);
		});

		it('refuses an unknown User as not_found', async () => {
			await expectDomainError(() => setSkills(db, actor, 9999, { vfx: 3 }, day(2)), 'not_found');
		});

		it('writes nothing when one entry is an unknown Skill', async () => {
			await expectDomainError(
				() => setSkills(db, actor, actor.id, { vfx: 3, nope: 2, audio: 1 }, day(2)),
				'invalid'
			);

			expect(await rowsOf(actor.id)).toEqual([]);
		});

		it('writes nothing when one entry is a bad level, even after valid ones', async () => {
			await expectDomainError(
				() => setSkills(db, actor, actor.id, { audio: 1, vfx: 6 }, day(2)),
				'invalid'
			);

			expect(await rowsOf(actor.id)).toEqual([]);
		});

		it('leaves existing levels and clears untouched when the call is refused', async () => {
			await setSkills(db, other, actor.id, { vfx: 2, audio: 4 }, day(2));

			await expectDomainError(
				() => setSkills(db, actor, actor.id, { vfx: 5, audio: null, 'combat-design': 9 }, day(3)),
				'invalid'
			);

			expect(await rowsOf(actor.id)).toEqual([
				{ key: 'audio', level: 4, setBy: other.id, via: null, setAt: day(2) },
				{ key: 'vfx', level: 2, setBy: other.id, via: null, setAt: day(2) }
			]);
		});
	});
});

describe('needs through appraise', () => {
	let realmId: number;
	let labourId: number;

	beforeEach(async () => {
		realmId = (await seedRealm(db, 'AM')).id;
		labourId = (await seedLabour(db, { realmId, title: 'Boss intro' })).id;
		await define('vfx', 'VFX');
		await define('combat-design', 'Combat design');
		await define('audio', 'Audio');
	});

	const needsOf = async (id = labourId) => (await readAppraisal(db, id)).needs;
	const need = (needs: Record<string, number | null>, id = labourId, by = actor, at = day(2)) =>
		appraise(db, by, [{ labourId: id, needs }], at);
	const needRows = async (id = labourId) =>
		await db
			.select({
				key: skills.key,
				level: labourNeeds.level,
				setBy: labourNeeds.setBy,
				via: labourNeeds.via,
				setAt: labourNeeds.setAt
			})
			.from(labourNeeds)
			.innerJoin(skills, eq(skills.id, labourNeeds.skillId))
			.where(eq(labourNeeds.labourId, id))
			.orderBy(skills.key);
	const eventCount = async () => (await db.select().from(events)).length;
	const updatedAt = async (id = labourId) =>
		(
			await db.select({ at: labours.updatedAt }).from(labours).where(eq(labours.id, id)).limit(1)
		)[0]!.at;

	async function defineMany(count: number) {
		const keys: string[] = [];
		for (let i = 1; i <= count; i++) {
			const key = `extra-${i}`;
			await define(key);
			keys.push(key);
		}
		return keys;
	}

	it('reads as empty for a Labour that needs nothing', async () => {
		expect(await needsOf()).toEqual([]);
	});

	it('sets needed levels, readable on the Appraisal as key, level, setBy and setAt', async () => {
		await need({ vfx: 3, 'combat-design': 4 }, labourId, actor, day(2));

		expect(await needsOf()).toEqual([
			{ key: 'combat-design', level: 4, setBy: actor.id, via: null, setAt: day(2) },
			{ key: 'vfx', level: 3, setBy: actor.id, via: null, setAt: day(2) }
		]);
	});

	it('orders needs by key, not by when the Skill or the need was created', async () => {
		await need({ vfx: 1 });
		await need({ audio: 2 });
		await need({ 'combat-design': 3 });

		expect((await needsOf()).map((n) => n.key)).toEqual(['audio', 'combat-design', 'vfx']);
	});

	it('merges: Skills not named keep their level, setBy and setAt', async () => {
		await need({ vfx: 3 }, labourId, other, day(2));

		await need({ audio: 2 }, labourId, actor, day(3));

		expect(await needsOf()).toEqual([
			{ key: 'audio', level: 2, setBy: actor.id, via: null, setAt: day(3) },
			{ key: 'vfx', level: 3, setBy: other.id, via: null, setAt: day(2) }
		]);
	});

	it('changes a level, rewriting setBy and setAt', async () => {
		await need({ vfx: 3 }, labourId, actor, day(2));

		await need({ vfx: 5 }, labourId, other, day(4));

		expect(await needsOf()).toEqual([
			{ key: 'vfx', level: 5, setBy: other.id, via: null, setAt: day(4) }
		]);
	});

	it('clears a need with null and leaves the others', async () => {
		await need({ vfx: 3, audio: 2, 'combat-design': 1 });

		await need({ audio: null }, labourId, actor, day(3));

		expect((await needsOf()).map((n) => [n.key, n.level])).toEqual([
			['combat-design', 1],
			['vfx', 3]
		]);
		expect((await needRows()).map((r) => r.key)).toEqual(['combat-design', 'vfx']);
	});

	it('clears and sets in the same item', async () => {
		await need({ vfx: 3, audio: 2 });

		await need({ audio: null, 'combat-design': 4 }, labourId, actor, day(3));

		expect((await needsOf()).map((n) => [n.key, n.level])).toEqual([
			['combat-design', 4],
			['vfx', 3]
		]);
	});

	it('accepts an item that names only needs, and an empty needs object', async () => {
		const result = await appraise(db, actor, [{ labourId, needs: { vfx: 3 } }], day(2));
		const empty = await appraise(db, actor, [{ labourId, needs: {} }], day(3));

		expect(result).toEqual([{ labourId, stamped: false }]);
		expect(empty).toEqual([{ labourId, stamped: false }]);
		expect((await needsOf()).map((n) => n.key)).toEqual(['vfx']);
	});

	it('keeps each Labour needs apart within one batch', async () => {
		const second = (await seedLabour(db, { realmId, title: 'Second' })).id;

		await appraise(
			db,
			actor,
			[
				{ labourId, needs: { vfx: 3 } },
				{ labourId: second, needs: { audio: 1 } }
			],
			day(2)
		);

		expect((await needsOf(labourId)).map((n) => n.key)).toEqual(['vfx']);
		expect((await needsOf(second)).map((n) => n.key)).toEqual(['audio']);
	});

	it('works across Realms: a Skill is named once for the instance', async () => {
		const otherRealm = (await seedRealm(db, 'BL')).id;
		const elsewhere = (await seedLabour(db, { realmId: otherRealm })).id;

		await need({ vfx: 2 }, elsewhere);

		expect(await needsOf(elsewhere)).toEqual([
			{ key: 'vfx', level: 2, setBy: actor.id, via: null, setAt: day(2) }
		]);
	});

	describe('the cap of 8 Skills per Labour', () => {
		it('allows 8 needs', async () => {
			const keys = await defineMany(8);

			await need(Object.fromEntries(keys.map((k) => [k, 3])));

			expect(await needsOf()).toHaveLength(8);
		});

		it('refuses an item that would leave 9, writing none of it', async () => {
			const keys = await defineMany(9);

			await expectDomainError(() => need(Object.fromEntries(keys.map((k) => [k, 3]))), 'invalid');

			expect(await needRows()).toEqual([]);
		});

		it('refuses a 9th need on a Labour that already has 8, leaving the 8 as they were', async () => {
			const keys = await defineMany(8);
			await need(Object.fromEntries(keys.map((k) => [k, 3])), labourId, actor, day(2));

			await expectDomainError(() => need({ vfx: 1 }, labourId, other, day(3)), 'invalid');

			expect(await needRows()).toHaveLength(8);
			expect(
				(await needRows()).every(
					(r) => r.setBy === actor.id && r.setAt.getTime() === day(2).getTime()
				)
			).toBe(true);
		});

		it('counts the Skills left after the item: clearing one while adding one keeps 8', async () => {
			const keys = await defineMany(8);
			await need(Object.fromEntries(keys.map((k) => [k, 3])));

			await need({ 'extra-1': null, vfx: 2 }, labourId, actor, day(3));

			const held = (await needsOf()).map((n) => n.key);
			expect(held).toHaveLength(8);
			expect(held).toContain('vfx');
			expect(held).not.toContain('extra-1');
		});

		it('counts the Skills left after the item: clearing two while adding two keeps 8', async () => {
			const keys = await defineMany(8);
			await need(Object.fromEntries(keys.map((k) => [k, 3])));

			await need({ 'extra-1': null, 'extra-2': null, vfx: 1, audio: 1 }, labourId, actor, day(3));

			expect(await needsOf()).toHaveLength(8);
		});

		it('refuses adding two while clearing one on a Labour with 8', async () => {
			const keys = await defineMany(8);
			await need(Object.fromEntries(keys.map((k) => [k, 3])));

			await expectDomainError(() => need({ 'extra-1': null, vfx: 1, audio: 1 }), 'invalid');

			expect(await needsOf()).toHaveLength(8);
			expect((await needsOf()).map((n) => n.key)).toContain('extra-1');
		});

		it('allows changing the level of a need on a Labour that already has 8', async () => {
			const keys = await defineMany(8);
			await need(Object.fromEntries(keys.map((k) => [k, 3])));

			await need({ 'extra-1': 5 }, labourId, actor, day(3));

			expect((await needsOf()).find((n) => n.key === 'extra-1')!.level).toBe(5);
		});

		it('refuses a need that would be the 9th even after clearing a Skill that was never needed', async () => {
			const keys = await defineMany(8);
			await need(Object.fromEntries(keys.map((k) => [k, 3])));

			await expectDomainError(() => need({ vfx: 1, audio: null }), 'invalid');
		});

		it('holds per Labour: another Labour can still have 8', async () => {
			const keys = await defineMany(8);
			const second = (await seedLabour(db, { realmId })).id;
			await need(Object.fromEntries(keys.map((k) => [k, 3])), labourId);

			await need(Object.fromEntries(keys.map((k) => [k, 2])), second);

			expect(await needsOf(second)).toHaveLength(8);
		});
	});

	describe('refusals refuse the whole batch', () => {
		const badLevels: [string, unknown][] = [
			['0', 0],
			['6', 6],
			['-1', -1],
			['a fraction', 2.5],
			['NaN', Number.NaN],
			['a string', '3'],
			['a boolean', true]
		];

		it('refuses an unknown Skill key as invalid', async () => {
			await expectDomainError(() => need({ nope: 3 }), 'invalid');
		});

		it('refuses an unknown Skill key given as null', async () => {
			await expectDomainError(() => need({ nope: null }), 'invalid');
		});

		it.each(badLevels)('refuses level %s as invalid', async (_, level) => {
			await expectDomainError(() => need({ vfx: level as number }), 'invalid');
			expect(await needRows()).toEqual([]);
		});

		it('writes none of an item when one of its entries is bad', async () => {
			await expectDomainError(() => need({ vfx: 3, audio: 9, 'combat-design': 2 }), 'invalid');
			await expectDomainError(() => need({ vfx: 3, nope: 1 }), 'invalid');

			expect(await needRows()).toEqual([]);
		});

		it('writes nothing from earlier items when a later item has a bad need', async () => {
			const second = (await seedLabour(db, { realmId })).id;

			await expectDomainError(
				() =>
					appraise(
						db,
						actor,
						[
							{ labourId, brief: 'lands only if all lands', needs: { vfx: 3 } },
							{ labourId: second, needs: { nope: 1 } }
						],
						day(2)
					),
				'invalid'
			);

			expect(await needRows(labourId)).toEqual([]);
			expect((await readAppraisal(db, labourId)).brief).toBe('');
		});

		it('writes no need when another item of the batch is refused for another reason', async () => {
			await expectDomainError(
				() =>
					appraise(
						db,
						actor,
						[
							{ labourId, needs: { vfx: 3 } },
							{ labourId: 99_999, brief: 'no such Labour' }
						],
						day(2)
					),
				'not_found'
			);

			expect(await needRows()).toEqual([]);
		});

		it('writes no need when a later item breaks the cap', async () => {
			const keys = await defineMany(9);
			const second = (await seedLabour(db, { realmId })).id;

			await expectDomainError(
				() =>
					appraise(
						db,
						actor,
						[
							{ labourId, needs: { vfx: 3 } },
							{ labourId: second, needs: Object.fromEntries(keys.map((k) => [k, 1])) }
						],
						day(2)
					),
				'invalid'
			);

			expect(await needRows(labourId)).toEqual([]);
			expect(await needRows(second)).toEqual([]);
		});

		it('keeps an existing need and clears untouched when the batch is refused', async () => {
			await need({ vfx: 3, audio: 2 }, labourId, other, day(2));

			await expectDomainError(
				() => need({ vfx: null, 'combat-design': 7 }, labourId, actor, day(3)),
				'invalid'
			);

			expect(await needsOf()).toEqual([
				{ key: 'audio', level: 2, setBy: other.id, via: null, setAt: day(2) },
				{ key: 'vfx', level: 3, setBy: other.id, via: null, setAt: day(2) }
			]);
		});
	});

	describe('outside the board and the content', () => {
		it('does not bump the Realm version, whether the Realm has settings or not', async () => {
			const tuned = (await seedRealm(db, 'BL')).id;
			await defineAttribute(
				db,
				actor,
				tuned,
				{ key: 'impact', kind: 'scale', label: 'Impact', rubric: 'r', spec: { min: 1, max: 5 } },
				day(1)
			);
			const inTuned = (await seedLabour(db, { realmId: tuned })).id;
			const before = (await readRealmAgent(db, tuned)).version;
			expect(before).toBeGreaterThan(0);

			await need({ vfx: 3 }, inTuned);
			await need({ vfx: null }, inTuned);
			await need({ audio: 2, 'combat-design': 1 }, labourId);

			expect((await readRealmAgent(db, tuned)).version).toBe(before);
			expect((await readRealmAgent(db, realmId)).version).toBe(0);
		});

		it('still bumps a Realm once for the values in an item that also carries needs', async () => {
			await defineAttribute(
				db,
				actor,
				realmId,
				{ key: 'impact', kind: 'scale', label: 'Impact', rubric: 'r', spec: { min: 1, max: 5 } },
				day(1)
			);
			const before = (await readRealmAgent(db, realmId)).version;

			await appraise(db, actor, [{ labourId, values: { impact: 4 }, needs: { vfx: 3 } }], day(2));

			expect((await readRealmAgent(db, realmId)).version).toBe(before + 1);
		});

		it('records no Event', async () => {
			const before = await eventCount();

			await need({ vfx: 3, audio: 2 });
			await need({ vfx: null });

			expect(await eventCount()).toBe(before);
		});

		it('leaves labours.updatedAt alone', async () => {
			const before = await updatedAt();

			await need({ vfx: 3 }, labourId, actor, day(20));

			expect(await updatedAt()).toEqual(before);
		});

		it('leaves the content hash alone, so a stamp taken before the needs still matches', async () => {
			const hash = await contentHash(db, labourId);

			const result = await appraise(
				db,
				actor,
				[{ labourId, needs: { vfx: 3 }, stamp: hash }],
				day(2)
			);

			expect(await contentHash(db, labourId)).toBe(hash);
			expect(result).toEqual([{ labourId, stamped: true }]);
			expect(await readAppraisal(db, labourId)).toMatchObject({ stale: false, unappraised: false });
		});

		it('does not make a stamped Appraisal stale', async () => {
			await appraise(db, actor, [{ labourId, stamp: await contentHash(db, labourId) }], day(2));

			await need({ vfx: 3, audio: 1 }, labourId, actor, day(3));
			await need({ vfx: null }, labourId, actor, day(4));

			expect((await readAppraisal(db, labourId)).stale).toBe(false);
		});

		it('does not touch the values of the Labour', async () => {
			await defineAttribute(
				db,
				actor,
				realmId,
				{ key: 'impact', kind: 'scale', label: 'Impact', rubric: 'r', spec: { min: 1, max: 5 } },
				day(1)
			);
			await setValues(db, other, labourId, { impact: 2 }, day(2));

			await need({ vfx: 3 }, labourId, actor, day(3));

			expect((await readAppraisal(db, labourId)).values).toMatchObject([
				{ key: 'impact', value: 2, setBy: other.id, via: null, setAt: day(2) }
			]);
		});
	});
});
