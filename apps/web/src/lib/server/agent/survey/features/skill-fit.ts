import { eq, sql } from 'drizzle-orm';
import { userSkills } from '../../../db/schema.ts';
import type { Feature } from './types.ts';

export const skillFit: Feature = {
	name: 'skill_fit',
	load({ db, candidates, candidateIds, forUserId }) {
		const fits = new Map<number, number | null>(candidates.map((c) => [c.id, null]));
		const held = new Map(
			db
				.select({ skillId: userSkills.skillId, level: userSkills.level })
				.from(userSkills)
				.where(eq(userSkills.userId, forUserId))
				.all()
				.map((row) => [row.skillId, row.level])
		);
		if (held.size === 0) return fits;

		const needs = db.all<{ labourId: number; skillId: number; level: number }>(sql`
			SELECT n.labour_id AS labourId, n.skill_id AS skillId, n.level AS level
			FROM json_each(${candidateIds}) c
			CROSS JOIN labour_needs n ON n.labour_id = c.value
		`);
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
