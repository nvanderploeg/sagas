import { sql } from 'drizzle-orm';
import { recentShares } from './decay.ts';
import type { Feature } from './types.ts';

export const mentions: Feature = {
	name: 'mentions',
	load({ db, candidateIds, now }) {
		const rows = db.all<{ id: number; at: number }>(sql`
			SELECT m.labour_id AS id, m.first_seen_at AS at
			FROM json_each(${candidateIds}) c
			CROSS JOIN mentions m ON m.labour_id = c.value
		`);
		return recentShares(now, rows);
	}
};
