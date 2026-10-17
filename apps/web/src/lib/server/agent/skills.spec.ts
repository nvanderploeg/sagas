import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labourNeeds, labours, skills, userSkills } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise, readAppraisal } from './appraisals.ts';
import { defineAttribute, readRealmAgent, setValues } from './attributes.ts';
import { contentHash } from './content.ts';
import { defineSkill, listSkills, readUserSkills, setSkills } from './skills.ts';

let db: Db;
let actor: Actor;
let other: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	other = { id: seedUser(db, 'other') };
});

afterEach(() => {
	db.$client.close();
});

const day = (n: number) => new Date(Date.UTC(2030, 0, n));

function expectDomainError(action: () => unknown, code: DomainError['code']): DomainError {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	return thrown as DomainError;
}

const define = (key: string, label = key, rubric?: string, now = day(1)) =>
	defineSkill(db, actor, { key, label, rubric }, now);

const skillCount = () => db.select().from(skills).all().length;

describe('defineSkill', () => {
	it('creates a Skill with the given label and an empty rubric, stamped with now', () => {
		const view = defineSkill(db, actor, { key: 'vfx', label: 'Visual effects' }, day(1));

		expect(view).toEqual({
			id: expect.any(Number),
			key: 'vfx',
			label: 'Visual effects',
			rubric: '',
			createdAt: day(1),
			updatedAt: day(1)
		});
		expect(db.select().from(skills).all()).toHaveLength(1);
	});

	it('creates a Skill with a rubric', () => {
		const view = defineSkill(
			db,
			actor,
			{ key: 'vfx', label: 'Visual effects', rubric: '1 = tweaks, 5 = owns the pipeline' },
			day(1)
		);

		expect(view.rubric).toBe('1 = tweaks, 5 = owns the pipeline');
	});

	it('trims and lowercases the key, and trims the label and the rubric', () => {
		const view = defineSkill(
			db,
			actor,
			{ key: '  VFX ', label: '  Visual effects  ', rubric: '  how good  ' },
			day(1)
		);

		expect(view).toMatchObject({ key: 'vfx', label: 'Visual effects', rubric: 'how good' });
	});

	it('accepts keys of 1 to 32 characters made of lowercase letters, digits and hyphens, starting with a letter', () => {
		for (const key of ['a', 'a1', 'combat-design', 'a-', 'a'.repeat(32)]) {
			expect(define(key).key, key).toBe(key);
		}
	});

	it('refuses a malformed key as invalid, creating nothing', () => {
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
			expectDomainError(() => define(key, 'Label'), 'invalid');
		}

		expect(skillCount()).toBe(0);
	});

	it('names no reserved words: Attribute and Survey names are fine as Skill keys', () => {
		for (const key of ['rank', 'priority', 'keywords', 'age']) {
			expect(define(key).key, key).toBe(key);
		}
	});

	it('requires a label when the key is new', () => {
		expectDomainError(() => defineSkill(db, actor, { key: 'vfx' }, day(1)), 'invalid');
		expectDomainError(() => defineSkill(db, actor, { key: 'vfx', rubric: 'r' }, day(1)), 'invalid');

		expect(skillCount()).toBe(0);
	});

	it('refuses a label that is empty after trimming or longer than 64 characters', () => {
		expectDomainError(() => define('vfx', ''), 'invalid');
		expectDomainError(() => define('vfx', '   '), 'invalid');
		expectDomainError(() => define('vfx', 'x'.repeat(65)), 'invalid');
		expect(skillCount()).toBe(0);

		expect(define('vfx', 'x'.repeat(64)).label).toHaveLength(64);
	});

	it('counts the label length after trimming', () => {
		expect(define('vfx', ` ${'x'.repeat(64)} `).label).toHaveLength(64);
	});

	it('accepts a rubric of 4,000 characters and refuses one of 4,001', () => {
		expectDomainError(() => define('vfx', 'VFX', 'r'.repeat(4001)), 'invalid');
		expect(skillCount()).toBe(0);

		expect(define('vfx', 'VFX', 'r'.repeat(4000)).rubric).toHaveLength(4000);
	});

	it('stores an empty or whitespace-only rubric as an empty string', () => {
		expect(define('vfx', 'VFX', '   ').rubric).toBe('');
	});

	describe('revising an existing Skill', () => {
		it('changes only the label, leaving the rubric and createdAt alone, and moves updatedAt', () => {
			const created = define('vfx', 'VFX', 'the rubric', day(1));

			const revised = defineSkill(db, actor, { key: 'vfx', label: 'Visual effects' }, day(2));

			expect(revised).toEqual({
				id: created.id,
				key: 'vfx',
				label: 'Visual effects',
				rubric: 'the rubric',
				createdAt: day(1),
				updatedAt: day(2)
			});
			expect(skillCount()).toBe(1);
		});

		it('changes only the rubric, leaving the label alone, and moves updatedAt', () => {
			define('vfx', 'Visual effects', 'old', day(1));

			const revised = defineSkill(db, actor, { key: 'vfx', rubric: 'new' }, day(3));

			expect(revised).toMatchObject({ label: 'Visual effects', rubric: 'new', updatedAt: day(3) });
		});

		it('clears the rubric with an empty string', () => {
			define('vfx', 'VFX', 'old', day(1));

			const revised = defineSkill(db, actor, { key: 'vfx', rubric: '' }, day(2));

			expect(revised.rubric).toBe('');
			expect(revised.updatedAt).toEqual(day(2));
		});

		it('matches the key after trimming and lowercasing, so it revises rather than creates', () => {
			const created = define('vfx', 'VFX', '', day(1));

			const revised = defineSkill(db, actor, { key: ' VfX ', label: 'Effects' }, day(2));

			expect(revised).toMatchObject({ id: created.id, key: 'vfx', label: 'Effects' });
			expect(skillCount()).toBe(1);
		});

		it('does not require a label', () => {
			define('vfx', 'VFX', 'old', day(1));

			expect(() => defineSkill(db, actor, { key: 'vfx', rubric: 'new' }, day(2))).not.toThrow();
		});

		it('leaves updatedAt alone when the given fields already match', () => {
			const created = define('vfx', 'VFX', 'rubric', day(1));

			const same = defineSkill(db, actor, { key: 'vfx', label: 'VFX', rubric: 'rubric' }, day(5));

			expect(same).toEqual(created);
			expect(db.select().from(skills).get()!.updatedAt).toEqual(day(1));
		});

		it('leaves updatedAt alone when only the key is given', () => {
			const created = define('vfx', 'VFX', 'rubric', day(1));

			expect(defineSkill(db, actor, { key: 'vfx' }, day(5))).toEqual(created);
		});

		it('compares trimmed values, so a padded label that matches is no change', () => {
			const created = define('vfx', 'VFX', 'rubric', day(1));

			const same = defineSkill(
				db,
				actor,
				{ key: 'vfx', label: '  VFX ', rubric: ' rubric ' },
				day(5)
			);

			expect(same.updatedAt).toEqual(created.updatedAt);
		});

		it('refuses an empty or over-long label and an over-long rubric, changing nothing', () => {
			define('vfx', 'VFX', 'rubric', day(1));

			expectDomainError(
				() => defineSkill(db, actor, { key: 'vfx', label: '  ' }, day(2)),
				'invalid'
			);
			expectDomainError(
				() => defineSkill(db, actor, { key: 'vfx', label: 'x'.repeat(65) }, day(2)),
				'invalid'
			);
			expectDomainError(
				() => defineSkill(db, actor, { key: 'vfx', rubric: 'r'.repeat(4001) }, day(2)),
				'invalid'
			);

			expect(db.select().from(skills).get()).toMatchObject({
				label: 'VFX',
				rubric: 'rubric',
				updatedAt: day(1)
			});
		});

		it('a refused revise does not apply the valid field that came with the bad one', () => {
			define('vfx', 'VFX', 'rubric', day(1));

			expectDomainError(
				() =>
					defineSkill(
						db,
						actor,
						{ key: 'vfx', label: 'Changed', rubric: 'r'.repeat(4001) },
						day(2)
					),
				'invalid'
			);

			expect(db.select().from(skills).get()).toMatchObject({ label: 'VFX', updatedAt: day(1) });
		});
	});
});

describe('listSkills', () => {
	it('is empty when no Skill is defined', () => {
		expect(listSkills(db)).toEqual([]);
	});

	it('lists every Skill by key, whatever order they were created in', () => {
		define('vfx', 'VFX');
		define('combat-design', 'Combat design');
		define('audio', 'Audio');

		expect(listSkills(db).map((s) => s.key)).toEqual(['audio', 'combat-design', 'vfx']);
	});

	it('carries the full view of each Skill with its holders', () => {
		const created = define('vfx', 'Visual effects', 'rubric', day(1));

		expect(listSkills(db)).toEqual([{ ...created, holders: 0 }]);
	});

	it('counts the Users who hold each Skill, and counts 0 for a Skill nobody holds', () => {
		define('audio');
		define('combat-design');
		define('vfx');
		setSkills(db, actor, actor.id, { vfx: 3, audio: 1 }, day(2));
		setSkills(db, actor, other.id, { vfx: 5 }, day(2));

		const holders = Object.fromEntries(listSkills(db).map((s) => [s.key, s.holders]));

		expect(holders).toEqual({ audio: 1, 'combat-design': 0, vfx: 2 });
	});

	it('stops counting a User who cleared the Skill', () => {
		define('vfx');
		setSkills(db, actor, actor.id, { vfx: 3 }, day(2));
		setSkills(db, actor, other.id, { vfx: 3 }, day(2));

		setSkills(db, actor, other.id, { vfx: null }, day(3));

		expect(listSkills(db)[0].holders).toBe(1);
	});
});

describe('setSkills', () => {
	beforeEach(() => {
		define('vfx', 'VFX');
		define('combat-design', 'Combat design');
		define('audio', 'Audio');
	});

	const rowsOf = (userId: number) =>
		db
			.select({
				key: skills.key,
				level: userSkills.level,
				setBy: userSkills.setBy,
				setAt: userSkills.setAt
			})
			.from(userSkills)
			.innerJoin(skills, eq(skills.id, userSkills.skillId))
			.where(eq(userSkills.userId, userId))
			.orderBy(skills.key)
			.all();

	it('sets the named levels and returns the whole set', () => {
		const result = setSkills(db, actor, actor.id, { vfx: 4, 'combat-design': 2 }, day(2));

		expect(result).toEqual({ vfx: 4, 'combat-design': 2 });
		expect(readUserSkills(db, actor.id)).toEqual({ vfx: 4, 'combat-design': 2 });
	});

	it('accepts every level from 1 to 5', () => {
		for (const level of [1, 2, 3, 4, 5]) {
			expect(setSkills(db, actor, actor.id, { vfx: level }, day(2)), String(level)).toEqual({
				vfx: level
			});
		}
	});

	it('merges: Skills not named keep their level, setBy and setAt', () => {
		setSkills(db, other, actor.id, { vfx: 4 }, day(2));

		const result = setSkills(db, actor, actor.id, { audio: 2 }, day(3));

		expect(result).toEqual({ vfx: 4, audio: 2 });
		expect(rowsOf(actor.id)).toEqual([
			{ key: 'audio', level: 2, setBy: actor.id, setAt: day(3) },
			{ key: 'vfx', level: 4, setBy: other.id, setAt: day(2) }
		]);
	});

	it('changes a level, rewriting setBy and setAt', () => {
		setSkills(db, actor, actor.id, { vfx: 2 }, day(2));

		const result = setSkills(db, other, actor.id, { vfx: 5 }, day(4));

		expect(result).toEqual({ vfx: 5 });
		expect(rowsOf(actor.id)).toEqual([{ key: 'vfx', level: 5, setBy: other.id, setAt: day(4) }]);
	});

	it('records the actor as setBy and now as setAt on each written row', () => {
		setSkills(db, actor, other.id, { vfx: 3, audio: 1 }, day(7));

		expect(rowsOf(other.id)).toEqual([
			{ key: 'audio', level: 1, setBy: actor.id, setAt: day(7) },
			{ key: 'vfx', level: 3, setBy: actor.id, setAt: day(7) }
		]);
	});

	it('clears a Skill with null, leaves the others, and returns the rest', () => {
		setSkills(db, actor, actor.id, { vfx: 4, audio: 2, 'combat-design': 1 }, day(2));

		const result = setSkills(db, actor, actor.id, { audio: null }, day(3));

		expect(result).toEqual({ vfx: 4, 'combat-design': 1 });
		expect(rowsOf(actor.id).map((r) => r.key)).toEqual(['combat-design', 'vfx']);
	});

	it('clears and sets in one call', () => {
		setSkills(db, actor, actor.id, { vfx: 4, audio: 2 }, day(2));

		const result = setSkills(db, actor, actor.id, { audio: null, 'combat-design': 3 }, day(3));

		expect(result).toEqual({ vfx: 4, 'combat-design': 3 });
	});

	it('clearing every Skill leaves an empty set', () => {
		setSkills(db, actor, actor.id, { vfx: 4, audio: 2 }, day(2));

		const result = setSkills(db, actor, actor.id, { vfx: null, audio: null }, day(3));

		expect(result).toEqual({});
		expect(rowsOf(actor.id)).toEqual([]);
	});

	it('keeps each User own set apart', () => {
		setSkills(db, actor, actor.id, { vfx: 4 }, day(2));
		setSkills(db, actor, other.id, { audio: 2 }, day(2));

		expect(readUserSkills(db, actor.id)).toEqual({ vfx: 4 });
		expect(readUserSkills(db, other.id)).toEqual({ audio: 2 });
	});

	it('lets any User set any Users Skills, not only their own', () => {
		const byOther = setSkills(db, other, actor.id, { vfx: 3 }, day(2));
		const byActor = setSkills(db, actor, other.id, { audio: 5 }, day(2));

		expect(byOther).toEqual({ vfx: 3 });
		expect(byActor).toEqual({ audio: 5 });
	});

	it('returns an empty set for a User with no Skills', () => {
		expect(readUserSkills(db, actor.id)).toEqual({});
	});

	describe('refusals', () => {
		it('refuses an unknown Skill key as invalid', () => {
			expectDomainError(() => setSkills(db, actor, actor.id, { nope: 3 }, day(2)), 'invalid');
		});

		it('refuses an unknown Skill key even when the value is null', () => {
			expectDomainError(() => setSkills(db, actor, actor.id, { nope: null }, day(2)), 'invalid');
		});

		it.each([0, 6, -1, 2.5, 100, Number.NaN, Number.POSITIVE_INFINITY])(
			'refuses level %s as invalid',
			(level) => {
				expectDomainError(() => setSkills(db, actor, actor.id, { vfx: level }, day(2)), 'invalid');
				expect(rowsOf(actor.id)).toEqual([]);
			}
		);

		it('refuses a level that is not a number', () => {
			for (const level of ['3', true, {}, [3]]) {
				expectDomainError(
					() => setSkills(db, actor, actor.id, { vfx: level as unknown as number }, day(2)),
					'invalid'
				);
			}
			expect(rowsOf(actor.id)).toEqual([]);
		});

		it('refuses an unknown User as not_found', () => {
			expectDomainError(() => setSkills(db, actor, 9999, { vfx: 3 }, day(2)), 'not_found');
		});

		it('writes nothing when one entry is an unknown Skill', () => {
			expectDomainError(
				() => setSkills(db, actor, actor.id, { vfx: 3, nope: 2, audio: 1 }, day(2)),
				'invalid'
			);

			expect(rowsOf(actor.id)).toEqual([]);
		});

		it('writes nothing when one entry is a bad level, even after valid ones', () => {
			expectDomainError(
				() => setSkills(db, actor, actor.id, { audio: 1, vfx: 6 }, day(2)),
				'invalid'
			);

			expect(rowsOf(actor.id)).toEqual([]);
		});

		it('leaves existing levels and clears untouched when the call is refused', () => {
			setSkills(db, other, actor.id, { vfx: 2, audio: 4 }, day(2));

			expectDomainError(
				() => setSkills(db, actor, actor.id, { vfx: 5, audio: null, 'combat-design': 9 }, day(3)),
				'invalid'
			);

			expect(rowsOf(actor.id)).toEqual([
				{ key: 'audio', level: 4, setBy: other.id, setAt: day(2) },
				{ key: 'vfx', level: 2, setBy: other.id, setAt: day(2) }
			]);
		});
	});
});

describe('needs through appraise', () => {
	let realmId: number;
	let labourId: number;

	beforeEach(() => {
		realmId = seedRealm(db, 'AM').id;
		labourId = seedLabour(db, { realmId, title: 'Boss intro' }).id;
		define('vfx', 'VFX');
		define('combat-design', 'Combat design');
		define('audio', 'Audio');
	});

	const needsOf = (id = labourId) => readAppraisal(db, id).needs;
	const need = (needs: Record<string, number | null>, id = labourId, by = actor, at = day(2)) =>
		appraise(db, by, [{ labourId: id, needs }], at);
	const needRows = (id = labourId) =>
		db
			.select({
				key: skills.key,
				level: labourNeeds.level,
				setBy: labourNeeds.setBy,
				setAt: labourNeeds.setAt
			})
			.from(labourNeeds)
			.innerJoin(skills, eq(skills.id, labourNeeds.skillId))
			.where(eq(labourNeeds.labourId, id))
			.orderBy(skills.key)
			.all();
	const eventCount = () => db.select().from(events).all().length;
	const updatedAt = (id = labourId) =>
		db.select({ at: labours.updatedAt }).from(labours).where(eq(labours.id, id)).get()!.at;

	function defineMany(count: number) {
		const keys: string[] = [];
		for (let i = 1; i <= count; i++) {
			const key = `extra-${i}`;
			define(key);
			keys.push(key);
		}
		return keys;
	}

	it('reads as empty for a Labour that needs nothing', () => {
		expect(needsOf()).toEqual([]);
	});

	it('sets needed levels, readable on the Appraisal as key, level, setBy and setAt', () => {
		need({ vfx: 3, 'combat-design': 4 }, labourId, actor, day(2));

		expect(needsOf()).toEqual([
			{ key: 'combat-design', level: 4, setBy: actor.id, setAt: day(2) },
			{ key: 'vfx', level: 3, setBy: actor.id, setAt: day(2) }
		]);
	});

	it('orders needs by key, not by when the Skill or the need was created', () => {
		need({ vfx: 1 });
		need({ audio: 2 });
		need({ 'combat-design': 3 });

		expect(needsOf().map((n) => n.key)).toEqual(['audio', 'combat-design', 'vfx']);
	});

	it('merges: Skills not named keep their level, setBy and setAt', () => {
		need({ vfx: 3 }, labourId, other, day(2));

		need({ audio: 2 }, labourId, actor, day(3));

		expect(needsOf()).toEqual([
			{ key: 'audio', level: 2, setBy: actor.id, setAt: day(3) },
			{ key: 'vfx', level: 3, setBy: other.id, setAt: day(2) }
		]);
	});

	it('changes a level, rewriting setBy and setAt', () => {
		need({ vfx: 3 }, labourId, actor, day(2));

		need({ vfx: 5 }, labourId, other, day(4));

		expect(needsOf()).toEqual([{ key: 'vfx', level: 5, setBy: other.id, setAt: day(4) }]);
	});

	it('clears a need with null and leaves the others', () => {
		need({ vfx: 3, audio: 2, 'combat-design': 1 });

		need({ audio: null }, labourId, actor, day(3));

		expect(needsOf().map((n) => [n.key, n.level])).toEqual([
			['combat-design', 1],
			['vfx', 3]
		]);
		expect(needRows().map((r) => r.key)).toEqual(['combat-design', 'vfx']);
	});

	it('clears and sets in the same item', () => {
		need({ vfx: 3, audio: 2 });

		need({ audio: null, 'combat-design': 4 }, labourId, actor, day(3));

		expect(needsOf().map((n) => [n.key, n.level])).toEqual([
			['combat-design', 4],
			['vfx', 3]
		]);
	});

	it('accepts an item that names only needs, and an empty needs object', () => {
		const result = appraise(db, actor, [{ labourId, needs: { vfx: 3 } }], day(2));
		const empty = appraise(db, actor, [{ labourId, needs: {} }], day(3));

		expect(result).toEqual([{ labourId, stamped: false }]);
		expect(empty).toEqual([{ labourId, stamped: false }]);
		expect(needsOf().map((n) => n.key)).toEqual(['vfx']);
	});

	it('keeps each Labour needs apart within one batch', () => {
		const second = seedLabour(db, { realmId, title: 'Second' }).id;

		appraise(
			db,
			actor,
			[
				{ labourId, needs: { vfx: 3 } },
				{ labourId: second, needs: { audio: 1 } }
			],
			day(2)
		);

		expect(needsOf(labourId).map((n) => n.key)).toEqual(['vfx']);
		expect(needsOf(second).map((n) => n.key)).toEqual(['audio']);
	});

	it('works across Realms: a Skill is named once for the instance', () => {
		const otherRealm = seedRealm(db, 'BL').id;
		const elsewhere = seedLabour(db, { realmId: otherRealm }).id;

		need({ vfx: 2 }, elsewhere);

		expect(needsOf(elsewhere)).toEqual([{ key: 'vfx', level: 2, setBy: actor.id, setAt: day(2) }]);
	});

	describe('the cap of 8 Skills per Labour', () => {
		it('allows 8 needs', () => {
			const keys = defineMany(8);

			need(Object.fromEntries(keys.map((k) => [k, 3])));

			expect(needsOf()).toHaveLength(8);
		});

		it('refuses an item that would leave 9, writing none of it', () => {
			const keys = defineMany(9);

			expectDomainError(() => need(Object.fromEntries(keys.map((k) => [k, 3]))), 'invalid');

			expect(needRows()).toEqual([]);
		});

		it('refuses a 9th need on a Labour that already has 8, leaving the 8 as they were', () => {
			const keys = defineMany(8);
			need(Object.fromEntries(keys.map((k) => [k, 3])), labourId, actor, day(2));

			expectDomainError(() => need({ vfx: 1 }, labourId, other, day(3)), 'invalid');

			expect(needRows()).toHaveLength(8);
			expect(
				needRows().every((r) => r.setBy === actor.id && r.setAt.getTime() === day(2).getTime())
			).toBe(true);
		});

		it('counts the Skills left after the item: clearing one while adding one keeps 8', () => {
			const keys = defineMany(8);
			need(Object.fromEntries(keys.map((k) => [k, 3])));

			need({ 'extra-1': null, vfx: 2 }, labourId, actor, day(3));

			const held = needsOf().map((n) => n.key);
			expect(held).toHaveLength(8);
			expect(held).toContain('vfx');
			expect(held).not.toContain('extra-1');
		});

		it('counts the Skills left after the item: clearing two while adding two keeps 8', () => {
			const keys = defineMany(8);
			need(Object.fromEntries(keys.map((k) => [k, 3])));

			need({ 'extra-1': null, 'extra-2': null, vfx: 1, audio: 1 }, labourId, actor, day(3));

			expect(needsOf()).toHaveLength(8);
		});

		it('refuses adding two while clearing one on a Labour with 8', () => {
			const keys = defineMany(8);
			need(Object.fromEntries(keys.map((k) => [k, 3])));

			expectDomainError(() => need({ 'extra-1': null, vfx: 1, audio: 1 }), 'invalid');

			expect(needsOf()).toHaveLength(8);
			expect(needsOf().map((n) => n.key)).toContain('extra-1');
		});

		it('allows changing the level of a need on a Labour that already has 8', () => {
			const keys = defineMany(8);
			need(Object.fromEntries(keys.map((k) => [k, 3])));

			need({ 'extra-1': 5 }, labourId, actor, day(3));

			expect(needsOf().find((n) => n.key === 'extra-1')!.level).toBe(5);
		});

		it('refuses a need that would be the 9th even after clearing a Skill that was never needed', () => {
			const keys = defineMany(8);
			need(Object.fromEntries(keys.map((k) => [k, 3])));

			expectDomainError(() => need({ vfx: 1, audio: null }), 'invalid');
		});

		it('holds per Labour: another Labour can still have 8', () => {
			const keys = defineMany(8);
			const second = seedLabour(db, { realmId }).id;
			need(Object.fromEntries(keys.map((k) => [k, 3])), labourId);

			need(Object.fromEntries(keys.map((k) => [k, 2])), second);

			expect(needsOf(second)).toHaveLength(8);
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

		it('refuses an unknown Skill key as invalid', () => {
			expectDomainError(() => need({ nope: 3 }), 'invalid');
		});

		it('refuses an unknown Skill key given as null', () => {
			expectDomainError(() => need({ nope: null }), 'invalid');
		});

		it.each(badLevels)('refuses level %s as invalid', (_, level) => {
			expectDomainError(() => need({ vfx: level as number }), 'invalid');
			expect(needRows()).toEqual([]);
		});

		it('writes none of an item when one of its entries is bad', () => {
			expectDomainError(() => need({ vfx: 3, audio: 9, 'combat-design': 2 }), 'invalid');
			expectDomainError(() => need({ vfx: 3, nope: 1 }), 'invalid');

			expect(needRows()).toEqual([]);
		});

		it('writes nothing from earlier items when a later item has a bad need', () => {
			const second = seedLabour(db, { realmId }).id;

			expectDomainError(
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

			expect(needRows(labourId)).toEqual([]);
			expect(readAppraisal(db, labourId).brief).toBe('');
		});

		it('writes no need when another item of the batch is refused for another reason', () => {
			expectDomainError(
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

			expect(needRows()).toEqual([]);
		});

		it('writes no need when a later item breaks the cap', () => {
			const keys = defineMany(9);
			const second = seedLabour(db, { realmId }).id;

			expectDomainError(
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

			expect(needRows(labourId)).toEqual([]);
			expect(needRows(second)).toEqual([]);
		});

		it('keeps an existing need and clears untouched when the batch is refused', () => {
			need({ vfx: 3, audio: 2 }, labourId, other, day(2));

			expectDomainError(
				() => need({ vfx: null, 'combat-design': 7 }, labourId, actor, day(3)),
				'invalid'
			);

			expect(needsOf()).toEqual([
				{ key: 'audio', level: 2, setBy: other.id, setAt: day(2) },
				{ key: 'vfx', level: 3, setBy: other.id, setAt: day(2) }
			]);
		});
	});

	describe('outside the board and the content', () => {
		it('does not bump the Realm version, whether the Realm has settings or not', () => {
			const tuned = seedRealm(db, 'BL').id;
			defineAttribute(
				db,
				actor,
				tuned,
				{ key: 'impact', kind: 'scale', label: 'Impact', rubric: 'r', spec: { min: 1, max: 5 } },
				day(1)
			);
			const inTuned = seedLabour(db, { realmId: tuned }).id;
			const before = readRealmAgent(db, tuned).version;
			expect(before).toBeGreaterThan(0);

			need({ vfx: 3 }, inTuned);
			need({ vfx: null }, inTuned);
			need({ audio: 2, 'combat-design': 1 }, labourId);

			expect(readRealmAgent(db, tuned).version).toBe(before);
			expect(readRealmAgent(db, realmId).version).toBe(0);
		});

		it('still bumps a Realm once for the values in an item that also carries needs', () => {
			defineAttribute(
				db,
				actor,
				realmId,
				{ key: 'impact', kind: 'scale', label: 'Impact', rubric: 'r', spec: { min: 1, max: 5 } },
				day(1)
			);
			const before = readRealmAgent(db, realmId).version;

			appraise(db, actor, [{ labourId, values: { impact: 4 }, needs: { vfx: 3 } }], day(2));

			expect(readRealmAgent(db, realmId).version).toBe(before + 1);
		});

		it('records no Event', () => {
			const before = eventCount();

			need({ vfx: 3, audio: 2 });
			need({ vfx: null });

			expect(eventCount()).toBe(before);
		});

		it('leaves labours.updatedAt alone', () => {
			const before = updatedAt();

			need({ vfx: 3 }, labourId, actor, day(20));

			expect(updatedAt()).toEqual(before);
		});

		it('leaves the content hash alone, so a stamp taken before the needs still matches', () => {
			const hash = contentHash(db, labourId);

			const result = appraise(db, actor, [{ labourId, needs: { vfx: 3 }, stamp: hash }], day(2));

			expect(contentHash(db, labourId)).toBe(hash);
			expect(result).toEqual([{ labourId, stamped: true }]);
			expect(readAppraisal(db, labourId)).toMatchObject({ stale: false, unappraised: false });
		});

		it('does not make a stamped Appraisal stale', () => {
			appraise(db, actor, [{ labourId, stamp: contentHash(db, labourId) }], day(2));

			need({ vfx: 3, audio: 1 }, labourId, actor, day(3));
			need({ vfx: null }, labourId, actor, day(4));

			expect(readAppraisal(db, labourId).stale).toBe(false);
		});

		it('does not touch the values of the Labour', () => {
			defineAttribute(
				db,
				actor,
				realmId,
				{ key: 'impact', kind: 'scale', label: 'Impact', rubric: 'r', spec: { min: 1, max: 5 } },
				day(1)
			);
			setValues(db, other, labourId, { impact: 2 }, day(2));

			need({ vfx: 3 }, labourId, actor, day(3));

			expect(readAppraisal(db, labourId).values).toMatchObject([
				{ key: 'impact', value: 2, setBy: other.id, setAt: day(2) }
			]);
		});
	});
});
