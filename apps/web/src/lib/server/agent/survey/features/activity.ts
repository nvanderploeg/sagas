import { sql } from 'drizzle-orm';
import { daysSince } from './decay.ts';
import type { Feature } from './types.ts';
import { intRows } from '#lib/server/db/lists.ts';

export const activity: Feature = {
	name: 'activity',
	async load({ db, candidates, candidateIds, now }) {
		const newest = new Map(
			(
				await db.execute<{ id: number; at: number }>(sql`
						SELECT c.value AS id, max(m.created_at) AS at
						FROM ${intRows(candidateIds)} AS c(value)
						JOIN comments m ON m.labour_id = c.value
						GROUP BY c.value
					`)
			).rows.map(({ id, at }) => [id, at])
		);
		return new Map(
			candidates.map(({ id, updatedAt }) => [
				id,
				2 ** (-daysSince(now, Math.max(updatedAt, newest.get(id) ?? 0)) / 7)
			])
		);
	}
};
