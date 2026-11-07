import { sql } from 'drizzle-orm';
import type { Feature } from './types.ts';
import { intList } from '#lib/server/db/lists.ts';

export const column: Feature = {
	name: 'column',
	async load({ db, candidates, candidateIds }) {
		const stateIds = [...new Set(candidates.map((candidate) => candidate.stateId))];
		const places = new Map<number, number>();
		if (stateIds.length === 0) return places;
		// Count places over the whole column, never only the candidates.
		const rows = (
			await db.execute<{ id: number; i: number; n: number }>(sql`
			SELECT id, i, n FROM (
				SELECT id,
					row_number() OVER (PARTITION BY state_id ORDER BY rank) - 1 AS i,
					count(*) OVER (PARTITION BY state_id) AS n
				FROM labours
				WHERE state_id IN ${intList(stateIds)}
			) t
			WHERE id IN ${intList(candidateIds)}
		`)
		).rows;
		for (const { id, i, n } of rows) places.set(id, n === 1 ? 1 : 1 - i / (n - 1));
		return places;
	}
};
