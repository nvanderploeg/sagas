import { sql } from 'drizzle-orm';
import { recentShares } from './decay.ts';
import type { Feature } from './types.ts';

export const pulledIn: Feature = {
	name: 'pulled_in',
	load({ db, candidateIds, forUserId, now }) {
		// Keep the unary +: on mentions_user_idx each candidate walks every Mention of the User.
		const rows = db.all<{ id: number; at: number }>(sql`
			SELECT m.source_labour_id AS id, m.first_seen_at AS at
			FROM json_each(${candidateIds}) c
			CROSS JOIN mentions m ON m.source_labour_id = c.value
			WHERE +m.user_id = ${forUserId}
		`);
		return recentShares(now, rows);
	}
};
