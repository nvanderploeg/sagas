import { sql, type SQL } from 'drizzle-orm';
import type { Handle } from '../../db/client.ts';
import { intList } from '#lib/server/db/lists.ts';

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
	openOnly?: true;
	// null matches unassigned.
	assigneeIds?: (number | null)[];
	// `attr:member` keys, all held.
	has: string[];
	labels: string[];
	questId?: number;
	unblocked: boolean;
};

function conditions(filter: CandidateFilter, now: number): SQL[] {
	const where: SQL[] = [sql`l.realm_id IN ${intList(filter.realmIds)}`];

	const live = filter.openOnly === true ? sql`s.is_open` : sql`NOT s.is_closed`;
	if (filter.includeClosed === undefined) {
		where.push(live);
	} else if (filter.includeClosed !== true) {
		const since = now - filter.includeClosed.withinDays * DAY_MS;
		where.push(sql`(${live} OR (s.is_closed AND l.updated_at >= ${since}))`);
	} else {
		where.push(sql`(${live} OR s.is_closed)`);
	}

	if (filter.assigneeIds !== undefined) {
		const ids = filter.assigneeIds.filter((id): id is number => id !== null);
		const either: SQL[] = [];
		if (ids.length > 0) either.push(sql`l.assignee_id IN ${intList(ids)}`);
		if (ids.length < filter.assigneeIds.length) either.push(sql`l.assignee_id IS NULL`);
		where.push(sql`(${sql.join(either, sql` OR `)})`);
	}

	for (const label of filter.labels) {
		where.push(sql`l.labels @> ${JSON.stringify([label])}::jsonb`);
	}

	if (filter.questId !== undefined) {
		where.push(
			sql`l.id IN (SELECT q.labour_id FROM sagas_quest_labours q WHERE q.quest_id = ${filter.questId})`
		);
	}

	for (const key of filter.has) {
		const [attribute, member] = key.split(':');
		where.push(sql`EXISTS (
			SELECT 1 FROM sagas_labour_attributes la
			JOIN sagas_attributes ta ON ta.id = la.attribute_id
			WHERE la.labour_id = l.id AND ta.key = ${attribute} AND ta.kind = 'tags'
				AND (la.value::jsonb) @> ${JSON.stringify([member])}::jsonb
		)`);
	}

	if (filter.unblocked) {
		where.push(sql`NOT EXISTS (
			SELECT 1 FROM sagas_links k
			JOIN sagas_labours b ON b.id = k.from_id
			JOIN sagas_states bs ON bs.id = b.state_id
			WHERE k.type = 'blocks' AND k.to_id = l.id AND NOT bs.is_closed
		)`);
	}
	return where;
}

type Row = Omit<Candidate, 'isClosed'> & { isClosed: boolean };

// In board order: Realm, State position, Rank.
export async function loadCandidates(
	tx: Handle,
	filter: CandidateFilter,
	now: number
): Promise<Candidate[]> {
	const rows = (
		await tx.execute<Row>(sql`
		SELECT l.id AS id, l.realm_id AS "realmId", l.state_id AS "stateId", s.is_closed AS "isClosed",
			l.assignee_id AS "assigneeId", r.key || '-' || l.number AS key, l.title AS title,
			r.key AS "realmKey", s.key AS "stateKey", coalesce(a.brief, '') AS brief,
			a.content_hash AS "contentHash", l.created_at AS "createdAt", l.updated_at AS "updatedAt"
		FROM sagas_labours l
		JOIN sagas_states s ON s.id = l.state_id
		JOIN sagas_realms r ON r.id = l.realm_id
		LEFT JOIN sagas_appraisals a ON a.labour_id = l.id
		WHERE ${sql.join(conditions(filter, now), sql` AND `)}
		ORDER BY l.realm_id, s.position, l.rank
	`)
	).rows;
	return rows;
}
