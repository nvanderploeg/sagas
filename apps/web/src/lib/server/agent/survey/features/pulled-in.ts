import { sql } from 'drizzle-orm';
import { recentShares } from './decay.ts';
import type { Feature } from './types.ts';
import { intRows } from '#lib/server/db/lists.ts';

export const pulledIn: Feature = {
	name: 'pulled_in',
	async load({ db, candidateIds, forUserId, now }) {
		const rows = (
			await db.execute<{ id: number; at: number }>(sql`
			SELECT m.source_labour_id AS id, m.first_seen_at AS at
			FROM ${intRows(candidateIds)} AS c(value)
			JOIN mentions m ON m.source_labour_id = c.value
			WHERE m.user_id = ${forUserId}
		`)
		).rows;
		return recentShares(now, rows);
	}
};
