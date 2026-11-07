import { asc, eq, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { comments, derivedBuilds, labours } from '../db/schema.ts';
import { refreshMentions } from './mentions.ts';
import { rebuildEmbeddingInputs } from './vectors/input.ts';
import { transact } from '#lib/server/db/tx.ts';

// Raise a version whenever the rules that build its structure change.
export const DERIVED_VERSIONS: { labour_text: number; mentions: number; embedding_inputs: number } =
	{
		labour_text: 1,
		mentions: 1,
		embedding_inputs: 1
	};

const BUILDERS: Record<keyof typeof DERIVED_VERSIONS, (tx: Handle) => void> = {
	labour_text: rebuildLabourText,
	mentions: rebuildMentions,
	embedding_inputs: rebuildEmbeddingInputs
};

// One transaction per structure, so a failed rebuild of one keeps the others.
export async function rebuildDerived(db: Db, now: Date = new Date()): Promise<string[]> {
	const rebuilt: string[] = [];
	for (const name of Object.keys(BUILDERS) as (keyof typeof BUILDERS)[]) {
		const version = DERIVED_VERSIONS[name];
		await transact(db, async (tx) => {
			const stored = (
				await tx
					.select({ version: derivedBuilds.version })
					.from(derivedBuilds)
					.where(eq(derivedBuilds.name, name))
					.limit(1)
			)[0];
			if (stored !== undefined && stored.version >= version) return;
			await BUILDERS[name](tx);
			await tx
				.insert(derivedBuilds)
				.values({ name, version, builtAt: now })
				.onConflictDoUpdate({ target: derivedBuilds.name, set: { version, builtAt: now } });
			rebuilt.push(name);
		});
	}
	return rebuilt;
}

// The same row refreshLabourText writes, for every Labour in one statement.
export async function rebuildLabourText(tx: Handle): Promise<void> {
	await tx.execute(sql`DELETE FROM labour_text`);
	await tx.execute(sql`
		INSERT INTO labour_text (labour_id, title, brief, description, comments, notes)
		SELECT l.id, l.title, coalesce(a.brief, ''), l.description,
			coalesce((
				SELECT string_agg(c.body, E'\n\n' ORDER BY c.id)
				FROM comments c WHERE c.labour_id = l.id
			), ''),
			coalesce((
				SELECT string_agg(la.value #>> '{}', E'\n\n' ORDER BY t.position)
				FROM labour_attributes la
				JOIN attributes t ON t.id = la.attribute_id
				WHERE la.labour_id = l.id AND t.kind = 'text'
			), '')
		FROM labours l
		LEFT JOIN appraisals a ON a.labour_id = l.id
	`);
}

async function rebuildMentions(tx: Handle): Promise<void> {
	const rows = await tx
		.select({
			id: labours.id,
			description: labours.description,
			ownerId: labours.ownerId,
			createdAt: labours.createdAt
		})
		.from(labours)
		.orderBy(asc(labours.id));
	for (const row of rows) {
		await refreshMentions(tx, {
			sourceLabourId: row.id,
			commentId: null,
			text: row.description,
			authorId: row.ownerId,
			firstSeenAt: row.createdAt
		});
	}
	for (const comment of await tx.select().from(comments).orderBy(asc(comments.id))) {
		await refreshMentions(tx, {
			sourceLabourId: comment.labourId,
			commentId: comment.id,
			text: comment.body,
			authorId: comment.authorId,
			firstSeenAt: comment.createdAt
		});
	}
}
