import { eq, sql } from 'drizzle-orm';
import { userSkills } from '../../../db/schema.ts';
import type { Feature } from './types.ts';
import { intRows } from '#lib/server/db/lists.ts';

export const skillFit: Feature = {
	name: 'skill_fit',
	async load({ db, candidates, candidateIds, forUserId }) {
		const fits = new Map<number, number | null>(candidates.map((c) => [c.id, null]));
		const held = new Map(
			(
				await db
					.select({ skillId: userSkills.skillId, level: userSkills.level })
					.from(userSkills)
					.where(eq(userSkills.userId, forUserId))
			).map((row) => [row.skillId, row.level])
		);
		if (held.size === 0) return fits;

		const needs = (
			await db.execute<{ labourId: number; skillId: number; level: number }>(sql`
			SELECT n.labour_id AS "labourId", n.skill_id AS "skillId", n.level AS level
			FROM ${intRows(candidateIds)} AS c(value)
			JOIN sagas_labour_needs n ON n.labour_id = c.value
		`)
		).rows;
		const sums = new Map<number, { total: number; count: number }>();
		for (const { labourId, skillId, level } of needs) {
			const sum = sums.get(labourId) ?? { total: 0, count: 0 };
			sum.total += Math.min(1, (held.get(skillId) ?? 0) / level);
			sum.count += 1;
			sums.set(labourId, sum);
		}
		for (const [labourId, { total, count }] of sums) fits.set(labourId, total / count);
		return fits;
	}
};
