import { eq, sql } from 'drizzle-orm';
import type { Db, Handle } from '../../db/client.ts';
import { labours, labourVectors } from '../../db/schema.ts';
import { MODEL_ID } from './embedder.ts';
import { intRows } from '#lib/server/db/lists.ts';
import { transact } from '#lib/server/db/tx.ts';

export type VectorStatus = 'current' | 'stale' | 'absent';

const VECTOR_BYTES = 384 * 4;

// Compare against labour_inputs, never the Labour's text: reading text makes every status check
// cost as much as the descriptions it covers.
const isCurrent = (model: string) =>
	sql`(v.model = ${model} AND v.input_hash = i.input_hash AND length(v.vector) = ${VECTOR_BYTES})`;

function toBuffer(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

// Copies: a Buffer from the driver is not aligned for a Float32Array view.
function toVector(blob: Buffer): Float32Array {
	return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

export async function statusAmong(
	db: Handle,
	ids: readonly number[],
	model: string
): Promise<Map<number, VectorStatus>> {
	const rows = (
		await db.execute<{ id: number; status: VectorStatus }>(sql`
		SELECT j.value AS id,
			CASE WHEN v.labour_id IS NULL THEN 'absent' WHEN ${isCurrent(model)} THEN 'current' ELSE 'stale' END AS status
		FROM ${intRows(ids)} WITH ORDINALITY AS j(value, n)
		LEFT JOIN sagas_labour_vectors v ON v.labour_id = j.value
		LEFT JOIN sagas_labour_inputs i ON i.labour_id = j.value
		ORDER BY j.n
	`)
	).rows;
	return new Map(rows.map((row) => [row.id, row.status]));
}

export async function currentVectors(
	db: Handle,
	ids: readonly number[],
	model: string
): Promise<Map<number, Float32Array>> {
	const rows = (
		await db.execute<{ id: number; vector: Buffer }>(sql`
		SELECT v.labour_id AS id, v.vector AS vector
		FROM ${intRows(ids)} AS j(value)
		JOIN sagas_labour_vectors v ON v.labour_id = j.value
		JOIN sagas_labour_inputs i ON i.labour_id = j.value
		WHERE ${isCurrent(model)}
	`)
	).rows;
	return new Map(rows.map((row) => [row.id, toVector(row.vector)]));
}

export async function countCurrent(
	db: Handle,
	ids: readonly number[],
	model: string
): Promise<number> {
	const row = (
		await db.execute<{ n: number }>(sql`
		SELECT count(*) AS n
		FROM ${intRows(ids)} AS j(value)
		JOIN sagas_labour_vectors v ON v.labour_id = j.value
		JOIN sagas_labour_inputs i ON i.labour_id = j.value
		WHERE ${isCurrent(model)}
	`)
	).rows[0];
	return row.n;
}

export async function scanCurrent(
	db: Handle,
	model: string,
	after: number,
	limit: number
): Promise<{ id: number; current: boolean }[]> {
	const rows = (
		await db.execute<{ id: number; current: boolean }>(sql`
		SELECT l.id AS id, coalesce(${isCurrent(model)}, false) AS current
		FROM sagas_labours l
		LEFT JOIN sagas_labour_vectors v ON v.labour_id = l.id
		LEFT JOIN sagas_labour_inputs i ON i.labour_id = l.id
		WHERE l.id > ${after}
		ORDER BY l.id
		LIMIT ${limit}
	`)
	).rows;
	return rows.map((row) => ({ id: row.id, current: row.current }));
}

export async function vectorStatus(
	db: Handle,
	labourIds: number[]
): Promise<Map<number, VectorStatus>> {
	return statusAmong(db, labourIds, MODEL_ID);
}

// Current vectors only: a stale one answers for text the Labour doesn't hold.
export async function readVectors(
	db: Handle,
	labourIds: number[]
): Promise<Map<number, Float32Array>> {
	return currentVectors(db, labourIds, MODEL_ID);
}

// Not an Event and not a Labour change: it never touches labours.updated_at.
export async function writeVector(
	db: Db,
	labourId: number,
	model: string,
	hash: string,
	vector: Float32Array,
	now: Date = new Date()
): Promise<void> {
	await transact(db, async (tx) => {
		const exists = (
			await tx.select({ id: labours.id }).from(labours).where(eq(labours.id, labourId)).limit(1)
		)[0];
		if (exists === undefined) return;
		const set = { model, vector: toBuffer(vector), inputHash: hash, embeddedAt: now };
		await tx
			.insert(labourVectors)
			.values({ labourId, ...set })
			.onConflictDoUpdate({ target: labourVectors.labourId, set });
	});
}
