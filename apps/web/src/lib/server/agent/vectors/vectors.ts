import { eq, sql } from 'drizzle-orm';
import type { Db, Handle } from '../../db/client.ts';
import { labours, labourVectors } from '../../db/schema.ts';
import { MODEL_ID } from './embedder.ts';

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

export function statusAmong(db: Handle, idsJson: string, model: string): Map<number, VectorStatus> {
	const rows = db.all<{ id: number; status: VectorStatus }>(sql`
		SELECT j.value AS id,
			CASE WHEN v.labour_id IS NULL THEN 'absent' WHEN ${isCurrent(model)} THEN 'current' ELSE 'stale' END AS status
		FROM json_each(${idsJson}) j
		LEFT JOIN labour_vectors v ON v.labour_id = j.value
		LEFT JOIN labour_inputs i ON i.labour_id = j.value
	`);
	return new Map(rows.map((row) => [row.id, row.status]));
}

export function currentVectors(
	db: Handle,
	idsJson: string,
	model: string
): Map<number, Float32Array> {
	const rows = db.all<{ id: number; vector: Buffer }>(sql`
		SELECT v.labour_id AS id, v.vector AS vector
		FROM json_each(${idsJson}) j
		JOIN labour_vectors v ON v.labour_id = j.value
		JOIN labour_inputs i ON i.labour_id = j.value
		WHERE ${isCurrent(model)}
	`);
	return new Map(rows.map((row) => [row.id, toVector(row.vector)]));
}

export function scanCurrent(
	db: Handle,
	model: string,
	after: number,
	limit: number
): { id: number; current: boolean }[] {
	const rows = db.all<{ id: number; current: number }>(sql`
		SELECT l.id AS id, coalesce(${isCurrent(model)}, 0) AS current
		FROM labours l
		LEFT JOIN labour_vectors v ON v.labour_id = l.id
		LEFT JOIN labour_inputs i ON i.labour_id = l.id
		WHERE l.id > ${after}
		ORDER BY l.id
		LIMIT ${limit}
	`);
	return rows.map((row) => ({ id: row.id, current: row.current === 1 }));
}

export function vectorStatus(db: Handle, labourIds: number[]): Map<number, VectorStatus> {
	return statusAmong(db, JSON.stringify(labourIds), MODEL_ID);
}

// Current vectors only: a stale one answers for text the Labour doesn't hold.
export function readVectors(db: Handle, labourIds: number[]): Map<number, Float32Array> {
	return currentVectors(db, JSON.stringify(labourIds), MODEL_ID);
}

// Not an Event and not a Labour change: it never touches labours.updated_at.
export function writeVector(
	db: Db,
	labourId: number,
	model: string,
	hash: string,
	vector: Float32Array,
	now: Date = new Date()
): void {
	db.transaction((tx) => {
		const exists = tx
			.select({ id: labours.id })
			.from(labours)
			.where(eq(labours.id, labourId))
			.get();
		if (exists === undefined) return;
		const set = { model, vector: toBuffer(vector), inputHash: hash, embeddedAt: now };
		tx.insert(labourVectors)
			.values({ labourId, ...set })
			.onConflictDoUpdate({ target: labourVectors.labourId, set })
			.run();
	});
}
