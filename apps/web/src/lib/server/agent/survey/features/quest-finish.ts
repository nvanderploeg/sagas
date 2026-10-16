import { sql } from 'drizzle-orm';
import type { Feature } from './types.ts';

// Counts follow questProgress in domain/quest-view.ts: every Realm's Labours.
export const questFinish: Feature = {
	name: 'quest_finish',
	load({ db, candidates }) {
		const best = new Map<number, number>();
		const open = candidates.filter((candidate) => !candidate.isClosed);
		if (open.length === 0) return best;
		const rows = db.all<{ id: number; closed: number; total: number }>(sql`
			WITH wanted AS (
				SELECT ql.labour_id AS labour_id, ql.quest_id AS quest_id
				FROM json_each(${JSON.stringify(open.map((candidate) => candidate.id))}) c
				CROSS JOIN quest_labours ql ON ql.labour_id = c.value
			),
			progress AS (
				SELECT q.quest_id AS quest_id, count(*) AS total, sum(s.is_closed) AS closed
				FROM (SELECT DISTINCT quest_id FROM wanted) q
				CROSS JOIN quest_labours ql ON ql.quest_id = q.quest_id
				JOIN labours l ON l.id = ql.labour_id
				JOIN states s ON s.id = l.state_id
				GROUP BY q.quest_id
			)
			SELECT w.labour_id AS id, p.closed AS closed, p.total AS total
			FROM wanted w
			JOIN progress p ON p.quest_id = w.quest_id
		`);
		for (const { id, closed, total } of rows) {
			best.set(id, Math.max(best.get(id) ?? 0, (closed + 1) / total));
		}
		return best;
	}
};
