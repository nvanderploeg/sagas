import { currentVia } from '#lib/server/auth/via.ts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { labourNeeds, skills, userSkills, users } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { requireMatch, STATE_KEY } from '../domain/validate.ts';
import type { Actor } from '../domain/write.ts';

export type SkillView = {
	id: number;
	key: string;
	label: string;
	rubric: string;
	createdAt: Date;
	updatedAt: Date;
};

export type NeedView = {
	key: string;
	level: number;
	setBy: number;
	via: string | null;
	setAt: Date;
};

export type SkillInput = { key: string; label?: string; rubric?: string };

export const NEEDS_MAX = 8;
export const LABEL_MAX = 64;
export const RUBRIC_MAX = 4000;

type SkillRow = typeof skills.$inferSelect;
type Levels = Record<string, number | null>;

function invalid(message: string): never {
	throw new DomainError('invalid', message);
}

const normalizeKey = (key: unknown): string =>
	typeof key === 'string' ? key.trim().toLowerCase() : '';

function viewOf(row: SkillRow): SkillView {
	const { id, key, label, rubric, createdAt, updatedAt } = row;
	return { id, key, label, rubric, createdAt, updatedAt };
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string') invalid(`${field} must be text`);
	return value.trim();
}

function normalizeLabel(value: unknown): string {
	const label = text(value, 'Skill label');
	if (label.length < 1 || label.length > LABEL_MAX) {
		invalid(`Skill label must be 1 to ${LABEL_MAX} characters`);
	}
	return label;
}

function normalizeRubric(value: unknown): string {
	const rubric = text(value, 'Skill rubric');
	if (rubric.length > RUBRIC_MAX) invalid(`Skill rubric must be at most ${RUBRIC_MAX} characters`);
	return rubric;
}

export function defineSkill(
	db: Db,
	_actor: Actor,
	input: SkillInput,
	now: Date = new Date()
): SkillView {
	return db.transaction((tx) => {
		const key = normalizeKey(input.key);
		requireMatch(
			key,
			STATE_KEY,
			'Skill key must be lowercase letters, digits and hyphens, starting with a letter'
		);
		const existing = tx.select().from(skills).where(eq(skills.key, key)).get();

		if (existing === undefined) {
			if (input.label === undefined) invalid('Creating a Skill needs a label');
			return viewOf(
				tx
					.insert(skills)
					.values({
						key,
						label: normalizeLabel(input.label),
						rubric: input.rubric === undefined ? '' : normalizeRubric(input.rubric),
						createdAt: now,
						updatedAt: now
					})
					.returning()
					.get()
			);
		}

		const label = input.label === undefined ? existing.label : normalizeLabel(input.label);
		const rubric = input.rubric === undefined ? existing.rubric : normalizeRubric(input.rubric);
		if (label === existing.label && rubric === existing.rubric) return viewOf(existing);
		return viewOf(
			tx
				.update(skills)
				.set({ label, rubric, updatedAt: now })
				.where(eq(skills.id, existing.id))
				.returning()
				.get()
		);
	});
}

export function listSkills(db: Handle): (SkillView & { holders: number })[] {
	return db
		.select({
			row: skills,
			holders: sql<number>`(SELECT count(*) FROM ${userSkills} WHERE ${userSkills.skillId} = ${skills.id})`
		})
		.from(skills)
		.orderBy(asc(skills.key))
		.all()
		.map(({ row, holders }) => ({ ...viewOf(row), holders }));
}

export function readUserSkills(db: Handle, userId: number): Record<string, number> {
	return Object.fromEntries(
		db
			.select({ key: skills.key, level: userSkills.level })
			.from(userSkills)
			.innerJoin(skills, eq(skills.id, userSkills.skillId))
			.where(eq(userSkills.userId, userId))
			.orderBy(asc(skills.key))
			.all()
			.map((row) => [row.key, row.level])
	);
}

export function readNeeds(db: Handle, labourId: number): NeedView[] {
	return db
		.select({
			key: skills.key,
			level: labourNeeds.level,
			setBy: labourNeeds.setBy,
			via: labourNeeds.via,
			setAt: labourNeeds.setAt
		})
		.from(labourNeeds)
		.innerJoin(skills, eq(skills.id, labourNeeds.skillId))
		.where(eq(labourNeeds.labourId, labourId))
		.orderBy(asc(skills.key))
		.all();
}

function plan(tx: Handle, levels: Levels): { skillId: number; level: number | null }[] {
	if (levels === null || typeof levels !== 'object' || Array.isArray(levels)) {
		invalid('Skills must be an object of Skill keys to levels');
	}
	const entries = Object.entries(levels).map(([raw, level]) => ({ key: normalizeKey(raw), level }));
	const seen = new Set<string>();
	for (const { key, level } of entries) {
		if (seen.has(key)) invalid(`Skill "${key}" is listed twice`);
		seen.add(key);
		if (level !== null && !(Number.isInteger(level) && level >= 1 && level <= 5)) {
			invalid(`Skill "${key}" takes a level from 1 to 5, or null to clear`);
		}
	}
	const ids = new Map(
		entries.length === 0
			? []
			: tx
					.select({ key: skills.key, id: skills.id })
					.from(skills)
					.where(
						inArray(
							skills.key,
							entries.map((entry) => entry.key)
						)
					)
					.all()
					.map((row) => [row.key, row.id])
	);
	return entries.map(({ key, level }) => {
		const skillId = ids.get(key);
		if (skillId === undefined) invalid(`Skill "${key}" does not exist`);
		return { skillId, level };
	});
}

export function setSkills(
	db: Db,
	actor: Actor,
	userId: number,
	levels: Levels,
	now: Date = new Date()
): Record<string, number> {
	return db.transaction((tx) => {
		if (tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).get() === undefined) {
			throw new DomainError('not_found', 'User not found');
		}
		for (const { skillId, level } of plan(tx, levels)) {
			const match = and(eq(userSkills.userId, userId), eq(userSkills.skillId, skillId));
			if (level === null) {
				tx.delete(userSkills).where(match).run();
				continue;
			}
			const set = { level, setBy: actor.id, via: currentVia(), setAt: now };
			tx.insert(userSkills)
				.values({ userId, skillId, ...set })
				.onConflictDoUpdate({ target: [userSkills.userId, userSkills.skillId], set })
				.run();
		}
		return readUserSkills(tx, userId);
	});
}

// Check the cap after the merge, never before: a clear in the same item frees a slot.
export function writeNeeds(
	tx: Handle,
	userId: number,
	labourId: number,
	levels: Levels,
	now: Date
): void {
	for (const { skillId, level } of plan(tx, levels)) {
		const match = and(eq(labourNeeds.labourId, labourId), eq(labourNeeds.skillId, skillId));
		if (level === null) {
			tx.delete(labourNeeds).where(match).run();
			continue;
		}
		const set = { level, setBy: userId, via: currentVia(), setAt: now };
		tx.insert(labourNeeds)
			.values({ labourId, skillId, ...set })
			.onConflictDoUpdate({ target: [labourNeeds.labourId, labourNeeds.skillId], set })
			.run();
	}
	const held = tx
		.select({ n: sql<number>`count(*)` })
		.from(labourNeeds)
		.where(eq(labourNeeds.labourId, labourId))
		.get()!.n;
	if (held > NEEDS_MAX) invalid(`A Labour needs at most ${NEEDS_MAX} Skills`);
}
