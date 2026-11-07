import { sql } from 'drizzle-orm';
import { recentShares } from './decay.ts';
import type { Feature } from './types.ts';
import { intRows } from '#lib/server/db/lists.ts';

export const mentions: Feature = {
	name: 'mentions',
	async load({ db, candidateIds, now }) {
		const rows = (
			await db.execute<{ id: number; at: number }>(sql`
			SELECT m.labour_id AS id, m.first_seen_at AS at
			FROM ${intRows(candidateIds)} AS c(value)
			JOIN mentions m ON m.labour_id = c.value
		`)
		).rows;
		return recentShares(now, rows);
	}
};
