import { sql } from 'drizzle-orm';
import type { Feature } from './types.ts';

export const column: Feature = {
	name: 'column',
	load({ db, candidates, candidateIds }) {
		const stateIds = [...new Set(candidates.map((candidate) => candidate.stateId))];
		const places = new Map<number, number>();
		if (stateIds.length === 0) return places;
		// Count places over the whole column, never only the candidates.
		const rows = db.all<{ id: number; i: number; n: number }>(sql`
			SELECT id, i, n FROM (
				SELECT id,
					row_number() OVER (PARTITION BY state_id ORDER BY rank) - 1 AS i,
					count(*) OVER (PARTITION BY state_id) AS n
				FROM labours
				WHERE state_id IN (SELECT value FROM json_each(${JSON.stringify(stateIds)}))
			)
			WHERE id IN (SELECT value FROM json_each(${candidateIds}))
		`);
		for (const { id, i, n } of rows) places.set(id, n === 1 ? 1 : 1 - i / (n - 1));
		return places;
	}
};
