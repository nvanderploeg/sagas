import { sql } from 'drizzle-orm';
import { saturating } from './decay.ts';
import type { Feature } from './types.ts';

export const unblocks: Feature = {
	name: 'unblocks',
	load({ db, candidateIds }) {
		const rows = db.all<{ id: number; n: number }>(sql`
			SELECT c.value AS id, count(*) AS n
			FROM json_each(${candidateIds}) c
			CROSS JOIN links k ON k.from_id = c.value AND k.type = 'blocks'
			JOIN labours t ON t.id = k.to_id
			JOIN states s ON s.id = t.state_id
			WHERE s.is_closed = 0
			GROUP BY c.value
		`);
		return new Map(rows.map(({ id, n }) => [id, saturating(n)]));
	}
};
