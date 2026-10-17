import { sql } from 'drizzle-orm';
import { saturating } from './decay.ts';
import type { Feature } from './types.ts';

export const evidence: Feature = {
	name: 'evidence',
	load({ db, candidateIds }) {
		const rows = db.all<{ id: number; n: number }>(sql`
			SELECT c.value AS id, count(*) AS n
			FROM json_each(${candidateIds}) c
			CROSS JOIN links k ON k.to_id = c.value AND k.type = 'evidence'
			GROUP BY c.value
		`);
		return new Map(rows.map(({ id, n }) => [id, saturating(n)]));
	}
};
