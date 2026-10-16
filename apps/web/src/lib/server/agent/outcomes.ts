import { eq, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { labours, outcomes, pulses, realms, surveys } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { formatLabourKey } from '../domain/keys.ts';
import type { Actor } from '../domain/write.ts';
import { loadHeldKeys } from './survey/features/sentiment.ts';

export const VERDICTS = ['picked', 'skipped', 'done'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const OUTCOMES_MAX = 50;
export const AFFINITY_HALF_LIFE_DAYS = 30;

const BASE: Record<Verdict, number> = { picked: 1, done: 2, skipped: 0.5 };

type Reported = { labourId: number; verdict: Verdict };
type Recorded = Reported & { recorded: boolean };

function invalid(message: string): never {
	throw new DomainError('invalid', message);
}

function checkItems(items: Reported[]): void {
	if (!Array.isArray(items) || items.length < 1 || items.length > OUTCOMES_MAX) {
		invalid(`Report 1 to ${OUTCOMES_MAX} Outcomes at a time`);
	}
	items.forEach((item, at) => {
		const where = `Outcome ${at + 1}`;
		if (item === null || typeof item !== 'object') invalid(`${where} must be an object`);
		if (!VERDICTS.includes(item.verdict)) {
			invalid(`${where} verdict must be one of ${VERDICTS.join(', ')}`);
		}
		if (!Number.isInteger(item.labourId) || item.labourId < 1) {
			invalid(`${where} labour must be a Labour id`);
		}
	});
}

export function reportOutcomes(
	db: Db,
	actor: Actor,
	surveyId: number,
	items: Reported[],
	now: Date = new Date()
): Recorded[] {
	checkItems(items);
	return db.transaction((tx) => {
		const survey = tx
			.select({ forId: surveys.forId, results: surveys.results })
			.from(surveys)
			.where(eq(surveys.id, surveyId))
			.get();
		if (survey === undefined) throw new DomainError('not_found', 'Survey not found');

		const returned = new Set((survey.results as { labour: number }[]).map((item) => item.labour));
		const keys = labourKeys(
			tx,
			items.map((item) => item.labourId)
		);
		for (const { labourId } of items) {
			if (!returned.has(labourId)) {
				invalid(`Labour ${labourId} is not among Survey ${surveyId}'s results`);
			}
			if (!keys.has(labourId)) invalid(`Labour ${labourId} does not exist`);
		}

		const results = items.map(({ labourId, verdict }): Recorded => {
			const stored = tx
				.insert(outcomes)
				.values({ surveyId, labourId, verdict, authorId: actor.id, createdAt: now })
				.onConflictDoNothing()
				.returning({ labourId: outcomes.labourId })
				.get();
			return { labourId, verdict, recorded: stored !== undefined };
		});

		postAffinity(tx, actor, { surveyId, userId: survey.forId, keys }, results, now);
		return results;
	});
}

function labourKeys(tx: Handle, ids: number[]): Map<number, string> {
	const rows = tx
		.select({ id: labours.id, number: labours.number, realmKey: realms.key })
		.from(labours)
		.innerJoin(realms, eq(realms.id, labours.realmId))
		.where(sql`${labours.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)
		.all();
	return new Map(rows.map((row) => [row.id, formatLabourKey(row.realmKey, row.number)]));
}

function postAffinity(
	tx: Handle,
	actor: Actor,
	target: { surveyId: number; userId: number; keys: Map<number, string> },
	results: Recorded[],
	now: Date
): void {
	const fresh = results.filter((result) => result.recorded);
	if (fresh.length === 0) return;
	const held = loadHeldKeys(tx, JSON.stringify([...new Set(fresh.map((r) => r.labourId))]));
	for (const { labourId, verdict } of fresh) {
		for (const entry of held.get(labourId) ?? []) {
			if (!(entry.x > 0)) continue;
			tx.insert(pulses)
				.values({
					userId: target.userId,
					attributeId: entry.attributeId,
					member: entry.member,
					rawKey: entry.member === null ? entry.attribute : `${entry.attribute}:${entry.member}`,
					amount: BASE[verdict] * entry.x,
					mood: verdict === 'skipped' ? -1 : 1,
					halfLifeDays: AFFINITY_HALF_LIFE_DAYS,
					note: `${verdict} ${target.keys.get(labourId)} in Survey ${target.surveyId}`,
					evidence: [{ labour: labourId }],
					authorId: actor.id,
					createdAt: now
				})
				.run();
		}
	}
}
