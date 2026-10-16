import { asc, eq, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { comments, derivedBuilds, labours } from '../db/schema.ts';
import { refreshMentions } from './mentions.ts';
import { refreshLabourText } from './search.ts';
import { rebuildEmbeddingInputs } from './vectors/input.ts';

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
export function rebuildDerived(db: Db, now: Date = new Date()): string[] {
	const rebuilt: string[] = [];
	for (const name of Object.keys(BUILDERS) as (keyof typeof BUILDERS)[]) {
		const version = DERIVED_VERSIONS[name];
		db.transaction((tx) => {
			const stored = tx
				.select({ version: derivedBuilds.version })
				.from(derivedBuilds)
				.where(eq(derivedBuilds.name, name))
				.get();
			if (stored !== undefined && stored.version >= version) return;
			BUILDERS[name](tx);
			tx.insert(derivedBuilds)
				.values({ name, version, builtAt: now })
				.onConflictDoUpdate({ target: derivedBuilds.name, set: { version, builtAt: now } })
				.run();
			rebuilt.push(name);
		});
	}
	return rebuilt;
}

function rebuildLabourText(tx: Handle): void {
	tx.run(sql`DELETE FROM labour_text`);
	const ids = tx.select({ id: labours.id }).from(labours).orderBy(asc(labours.id)).all();
	for (const { id } of ids) refreshLabourText(tx, id);
}

function rebuildMentions(tx: Handle): void {
	const rows = tx
		.select({
			id: labours.id,
			description: labours.description,
			ownerId: labours.ownerId,
			createdAt: labours.createdAt
		})
		.from(labours)
		.orderBy(asc(labours.id))
		.all();
	for (const row of rows) {
		refreshMentions(tx, {
			sourceLabourId: row.id,
			commentId: null,
			text: row.description,
			authorId: row.ownerId,
			firstSeenAt: row.createdAt
		});
	}
	for (const comment of tx.select().from(comments).orderBy(asc(comments.id)).all()) {
		refreshMentions(tx, {
			sourceLabourId: comment.labourId,
			commentId: comment.id,
			text: comment.body,
			authorId: comment.authorId,
			firstSeenAt: comment.createdAt
		});
	}
}
