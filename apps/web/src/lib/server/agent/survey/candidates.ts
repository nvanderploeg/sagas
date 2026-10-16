import { sql, type SQL } from 'drizzle-orm';
import type { Handle } from '../../db/client.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Candidate = {
	id: number;
	realmId: number;
	stateId: number;
	isClosed: boolean;
	assigneeId: number | null;
	// The current Labour key.
	key: string;
	title: string;
	realmKey: string;
	stateKey: string;
	// '' when none.
	brief: string;
	// Null until an Appraisal stamps the Labour.
	contentHash: string | null;
	createdAt: number;
	updatedAt: number;
};

export type CandidateFilter = {
	realmIds: number[];
	includeClosed?: true | { withinDays: number };
	// null matches unassigned.
	assigneeIds?: (number | null)[];
	// `attr:member` keys, all held.
	has: string[];
	labels: string[];
	questId?: number;
	unblocked: boolean;
};

const anyOf = (ids: readonly number[]) =>
	sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;

function conditions(filter: CandidateFilter, now: number): SQL[] {
	const where: SQL[] = [sql`l.realm_id IN ${anyOf(filter.realmIds)}`];

	if (filter.includeClosed === undefined) {
		where.push(sql`s.is_closed = 0`);
	} else if (filter.includeClosed !== true) {
		const since = now - filter.includeClosed.withinDays * DAY_MS;
		where.push(sql`(s.is_closed = 0 OR l.updated_at >= ${since})`);
	}

	if (filter.assigneeIds !== undefined) {
		const ids = filter.assigneeIds.filter((id): id is number => id !== null);
		const either: SQL[] = [];
		if (ids.length > 0) either.push(sql`l.assignee_id IN ${anyOf(ids)}`);
		if (ids.length < filter.assigneeIds.length) either.push(sql`l.assignee_id IS NULL`);
		where.push(sql`(${sql.join(either, sql` OR `)})`);
	}

	for (const label of filter.labels) {
		where.push(sql`EXISTS (SELECT 1 FROM json_each(l.labels) WHERE json_each.value = ${label})`);
	}

	if (filter.questId !== undefined) {
		where.push(
			sql`l.id IN (SELECT q.labour_id FROM quest_labours q WHERE q.quest_id = ${filter.questId})`
		);
	}

	for (const key of filter.has) {
		const [attribute, member] = key.split(':');
		where.push(sql`EXISTS (
			SELECT 1 FROM labour_attributes la
			JOIN attributes ta ON ta.id = la.attribute_id
			WHERE la.labour_id = l.id AND ta.key = ${attribute} AND ta.kind = 'tags'
				AND EXISTS (SELECT 1 FROM json_each(la.value) WHERE json_each.value = ${member})
		)`);
	}

	if (filter.unblocked) {
		where.push(sql`NOT EXISTS (
			SELECT 1 FROM links k
			JOIN labours b ON b.id = k.from_id
			JOIN states bs ON bs.id = b.state_id
			WHERE k.type = 'blocks' AND k.to_id = l.id AND bs.is_closed = 0
		)`);
	}
	return where;
}

type Row = Omit<Candidate, 'isClosed'> & { isClosed: number };

// In board order: Realm, State position, Rank.
export function loadCandidates(tx: Handle, filter: CandidateFilter, now: number): Candidate[] {
	const rows = tx.all<Row>(sql`
		SELECT l.id AS id, l.realm_id AS realmId, l.state_id AS stateId, s.is_closed AS isClosed,
			l.assignee_id AS assigneeId, r.key || '-' || l.number AS key, l.title AS title,
			r.key AS realmKey, s.key AS stateKey, coalesce(a.brief, '') AS brief,
			a.content_hash AS contentHash, l.created_at AS createdAt, l.updated_at AS updatedAt
		FROM labours l
		JOIN states s ON s.id = l.state_id
		JOIN realms r ON r.id = l.realm_id
		LEFT JOIN appraisals a ON a.labour_id = l.id
		WHERE ${sql.join(conditions(filter, now), sql` AND `)}
		ORDER BY l.realm_id, s.position, l.rank
	`);
	return rows.map((row) => ({ ...row, isClosed: row.isClosed === 1 }));
}
