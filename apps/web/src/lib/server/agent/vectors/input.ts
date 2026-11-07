import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Handle } from '../../db/client.ts';
import { labourInputs } from '../../db/schema.ts';
import { intRows } from '#lib/server/db/lists.ts';

export type EmbeddingText = { title: string; brief: string; description: string };

const CHUNK = 500;

// The input as docs/agent-layer-data.md, Hashes, defines it.
export function embeddingInput({ title, brief, description }: EmbeddingText): string {
	return [title, brief, description]
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.join('\n\n');
}

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

export function inputHash(text: EmbeddingText): string {
	return sha256(embeddingInput(text));
}

// Labour id to its embedding text; a Labour that does not exist is left out.
export async function readEmbeddingTexts(
	db: Handle,
	labourIds: readonly number[]
): Promise<Map<number, EmbeddingText>> {
	const texts = new Map<number, EmbeddingText>();
	if (labourIds.length === 0) return texts;
	const rows = (
		await db.execute<{ id: number; title: string; description: string; brief: string | null }>(sql`
		SELECT l.id AS id, l.title AS title, l.description AS description, a.brief AS brief
		FROM ${intRows(labourIds)} AS j(value)
		JOIN labours l ON l.id = j.value
		LEFT JOIN appraisals a ON a.labour_id = l.id
	`)
	).rows;
	for (const row of rows) {
		texts.set(row.id, { title: row.title, brief: row.brief ?? '', description: row.description });
	}
	return texts;
}

async function storeHash(tx: Handle, labourId: number, hash: string): Promise<void> {
	await tx
		.insert(labourInputs)
		.values({ labourId, inputHash: hash })
		.onConflictDoUpdate({ target: labourInputs.labourId, set: { inputHash: hash } });
}

export async function refreshEmbeddingInput(
	tx: Handle,
	labourId: number
): Promise<{ input: string; hash: string } | undefined> {
	const text = (await readEmbeddingTexts(tx, [labourId])).get(labourId);
	if (text === undefined) return undefined;
	const input = embeddingInput(text);
	const hash = sha256(input);
	await storeHash(tx, labourId, hash);
	return { input, hash };
}

// Chunked, so the text held at once stays bounded however many Labours there are.
export async function rebuildEmbeddingInputs(tx: Handle): Promise<void> {
	await tx.execute(sql`DELETE FROM labour_inputs`);
	let after = 0;
	for (;;) {
		const ids = (
			await tx.execute<{ id: number }>(
				sql`SELECT id FROM labours WHERE id > ${after} ORDER BY id LIMIT ${CHUNK}`
			)
		).rows.map((row) => row.id);
		if (ids.length === 0) return;
		for (const [labourId, text] of await readEmbeddingTexts(tx, ids)) {
			await storeHash(tx, labourId, inputHash(text));
		}
		after = ids[ids.length - 1];
	}
}
