import { asc, eq, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import {
	appraisals,
	attributes,
	comments,
	labourAttributes,
	labours,
	labourText
} from '../db/schema.ts';
import { intList } from '#lib/server/db/lists.ts';

const TOKEN = /[\p{L}\p{N}]+/gu;
const JOIN = '\n\n';

// ts_rank_cd weights for the classes {D, C, B, A}: description and comments 1, notes 2, brief 3,
// title 4, as labour_text's setweight assignment orders them.
const WEIGHTS = sql.raw(`'{0.25, 0.5, 0.75, 1.0}'::float4[]`);

// Divides by 1 + log(document length): a short title outranks the same word in a long one.
const LENGTH_NORMALIZATION = 1;

export const TERMS_MAX = 64;
const TERM_LENGTH_MAX = 64;

// The first TERMS_MAX distinct runs of letters and digits as quoted terms, OR-ed; the query's own
// syntax never reaches to_tsquery, and its size never reaches the planner.
export function tsQuery(query: string): string | null {
	const terms = new Set<string>();
	for (const run of query.match(TOKEN) ?? []) {
		terms.add(run.slice(0, TERM_LENGTH_MAX));
		if (terms.size === TERMS_MAX) break;
	}
	return terms.size === 0 ? null : [...terms].map((term) => `'${term}'`).join(' | ');
}

// Labour id to relevance in (0, 1]; the best match is 1.
export async function keywordScores(db: Handle, query: string): Promise<Map<number, number>> {
	const expression = tsQuery(query);
	if (expression === null) return new Map();
	return relevance(
		(
			await db.execute<{ id: number; score: number }>(sql`
				SELECT t.labour_id AS id, ts_rank_cd(${WEIGHTS}, t.search, q, ${LENGTH_NORMALIZATION}) AS score
				FROM sagas_labour_text t, to_tsquery('sagas_english', ${expression}) q
				WHERE t.search @@ q
			`)
		).rows
	);
}

// As keywordScores, over only the Labours in `ids`: the best of them is 1.
export async function keywordScoresAmong(
	db: Handle,
	query: string,
	ids: readonly number[]
): Promise<Map<number, number>> {
	const expression = tsQuery(query);
	if (expression === null) return new Map();
	return relevance(
		(
			await db.execute<{ id: number; score: number }>(sql`
				SELECT t.labour_id AS id, ts_rank_cd(${WEIGHTS}, t.search, q, ${LENGTH_NORMALIZATION}) AS score
				FROM sagas_labour_text t, to_tsquery('sagas_english', ${expression}) q
				WHERE t.search @@ q AND t.labour_id IN ${intList(ids)}
			`)
		).rows
	);
}

function relevance(rows: { id: number; score: number }[]): Map<number, number> {
	const gains = rows.map((row) => ({ id: row.id, gain: Math.max(row.score, 1e-12) }));
	const best = gains.reduce((top, entry) => Math.max(top, entry.gain), 0);
	return new Map(gains.map(({ id, gain }) => [id, gain / best]));
}

// Rewrite the whole row from the tables, never patch one column: every column has several writers.
export async function refreshLabourText(tx: Handle, labourId: number): Promise<void> {
	const labour = (
		await tx
			.select({ title: labours.title, description: labours.description })
			.from(labours)
			.where(eq(labours.id, labourId))
			.limit(1)
	)[0];
	if (labour === undefined) {
		await removeLabourText(tx, labourId);
		return;
	}
	const brief = (
		await tx
			.select({ brief: appraisals.brief })
			.from(appraisals)
			.where(eq(appraisals.labourId, labourId))
			.limit(1)
	)[0];
	const bodies = await tx
		.select({ body: comments.body })
		.from(comments)
		.where(eq(comments.labourId, labourId))
		.orderBy(asc(comments.id));
	const notes = await tx
		.select({ value: labourAttributes.value })
		.from(labourAttributes)
		.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
		.where(sql`${labourAttributes.labourId} = ${labourId} AND ${attributes.kind} = 'text'`)
		.orderBy(asc(attributes.position));
	const row = {
		title: labour.title,
		brief: brief?.brief ?? '',
		description: labour.description,
		comments: bodies.map((entry) => entry.body).join(JOIN),
		notes: notes.map((entry) => entry.value as string).join(JOIN)
	};
	await tx
		.insert(labourText)
		.values({ labourId, ...row })
		.onConflictDoUpdate({ target: labourText.labourId, set: row });
}

export async function removeLabourText(tx: Handle, labourId: number): Promise<void> {
	await tx.delete(labourText).where(eq(labourText.labourId, labourId));
}
