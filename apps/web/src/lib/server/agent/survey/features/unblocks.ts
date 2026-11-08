import { sql } from 'drizzle-orm';
import { saturating } from './decay.ts';
import type { Feature } from './types.ts';
import { intRows } from '#lib/server/db/lists.ts';

export const unblocks: Feature = {
	name: 'unblocks',
	async load({ db, candidateIds }) {
		const rows = (
			await db.execute<{ id: number; n: number }>(sql`
			SELECT c.value AS id, count(*) AS n
			FROM ${intRows(candidateIds)} AS c(value)
			JOIN links k ON k.from_id = c.value AND k.type = 'blocks'
			JOIN labours t ON t.id = k.to_id
			JOIN states s ON s.id = t.state_id
			WHERE NOT s.is_closed
			GROUP BY c.value
		`)
		).rows;
		return new Map(rows.map(({ id, n }) => [id, saturating(n)]));
	}
};
