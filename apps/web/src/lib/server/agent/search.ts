import { asc, eq, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { appraisals, attributes, comments, labourAttributes, labours } from '../db/schema.ts';

const TOKEN = /[\p{L}\p{N}]+/gu;
const JOIN = '\n\n';

// Column weights follow labour_text's column order: title, brief, description, comments, notes.
const BM25 = sql.raw('bm25(labour_text, 4, 3, 1, 1, 2)');

export function matchExpression(query: string): string | null {
	const runs = query.match(TOKEN);
	return runs === null ? null : runs.map((run) => `"${run}"`).join(' OR ');
}

// Labour id to relevance in (0, 1]; the best match is 1.
export function keywordScores(db: Handle, query: string): Map<number, number> {
	const expression = matchExpression(query);
	const scores = new Map<number, number>();
	if (expression === null) return scores;
	const rows = db.all<{ id: number; score: number }>(
		sql`SELECT rowid AS id, ${BM25} AS score FROM labour_text WHERE labour_text MATCH ${expression}`
	);
	// bm25 is negative and lower is better.
	const gains = rows.map((row) => ({ id: row.id, gain: Math.max(-row.score, 1e-12) }));
	const best = gains.reduce((top, entry) => Math.max(top, entry.gain), 0);
	for (const { id, gain } of gains) scores.set(id, gain / best);
	return scores;
}

// Rewrite the whole row from the tables, never patch one column: every column has several writers.
export function refreshLabourText(tx: Handle, labourId: number): void {
	const labour = tx
		.select({ title: labours.title, description: labours.description })
		.from(labours)
		.where(eq(labours.id, labourId))
		.get();
	if (labour === undefined) {
		removeLabourText(tx, labourId);
		return;
	}
	const brief = tx
		.select({ brief: appraisals.brief })
		.from(appraisals)
		.where(eq(appraisals.labourId, labourId))
		.get();
	const bodies = tx
		.select({ body: comments.body })
		.from(comments)
		.where(eq(comments.labourId, labourId))
		.orderBy(asc(comments.id))
		.all();
	const notes = tx
		.select({ value: labourAttributes.value })
		.from(labourAttributes)
		.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
		.where(sql`${labourAttributes.labourId} = ${labourId} AND ${attributes.kind} = 'text'`)
		.orderBy(asc(attributes.position))
		.all();
	tx.run(sql`INSERT OR REPLACE INTO labour_text(rowid, title, brief, description, comments, notes)
		VALUES (
			${labourId},
			${labour.title},
			${brief?.brief ?? ''},
			${labour.description},
			${bodies.map((row) => row.body).join(JOIN)},
			${notes.map((row) => row.value as string).join(JOIN)}
		)`);
}

export function removeLabourText(tx: Handle, labourId: number): void {
	tx.run(sql`DELETE FROM labour_text WHERE rowid = ${labourId}`);
}
