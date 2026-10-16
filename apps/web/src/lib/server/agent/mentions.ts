import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { labourKeys, mentions, users } from '../db/schema.ts';
import { LABOUR_KEY_IN_TEXT } from '../domain/keys.ts';

export const MENTIONS_SHOWN = 10;

const USERNAME_IN_TEXT = /(?<![A-Za-z0-9_.])@([A-Za-z][A-Za-z0-9_-]{1,31})/g;

export type MentionView = {
	sourceLabourId: number;
	commentId: number | null;
	authorId: number;
	firstSeenAt: Date;
};

export type MentionText = {
	sourceLabourId: number;
	// Null when the text is the Labour's description.
	commentId: number | null;
	text: string;
	authorId: number;
	// Stamps only the Mentions this text did not hold before.
	firstSeenAt: Date;
};

type Targets = { labourIds: Set<number>; userIds: Set<number> };

function scan(text: string): { keys: string[]; names: { exact: string; trimmed: string }[] } {
	const keys = new Set<string>();
	for (const match of text.matchAll(LABOUR_KEY_IN_TEXT)) {
		keys.add(`${match[1]}-${match[2]}`.toUpperCase());
	}
	const names = new Map<string, { exact: string; trimmed: string }>();
	for (const match of text.matchAll(USERNAME_IN_TEXT)) {
		const exact = match[1].toLowerCase();
		names.set(exact, { exact, trimmed: exact.replace(/[-_]+$/, '') });
	}
	return { keys: [...keys], names: [...names.values()] };
}

function resolve(tx: Handle, text: string, sourceLabourId: number): Targets {
	const found = scan(text);
	const labourIds = new Set<number>();
	if (found.keys.length > 0) {
		const rows = tx
			.select({ labourId: labourKeys.labourId })
			.from(labourKeys)
			.where(inArray(labourKeys.key, found.keys))
			.all();
		for (const row of rows) labourIds.add(row.labourId);
		labourIds.delete(sourceLabourId);
	}

	const userIds = new Set<number>();
	if (found.names.length > 0) {
		const candidates = [...new Set(found.names.flatMap((name) => [name.exact, name.trimmed]))];
		const byName = new Map(
			tx
				.select({ id: users.id, username: users.username })
				.from(users)
				.where(inArray(users.username, candidates))
				.all()
				.map((row) => [row.username, row.id])
		);
		for (const { exact, trimmed } of found.names) {
			const id = byName.get(exact) ?? byName.get(trimmed);
			if (id !== undefined) userIds.add(id);
		}
	}
	return { labourIds, userIds };
}

// Leave kept rows untouched: their firstSeenAt and authorId must survive edits.
export function refreshMentions(tx: Handle, input: MentionText): void {
	const targets = resolve(tx, input.text, input.sourceLabourId);
	const held = tx
		.select()
		.from(mentions)
		.where(
			and(
				eq(mentions.sourceLabourId, input.sourceLabourId),
				input.commentId === null
					? isNull(mentions.commentId)
					: eq(mentions.commentId, input.commentId)
			)
		)
		.all();

	const gone = held
		.filter((row) =>
			row.labourId === null
				? !targets.userIds.has(row.userId!)
				: !targets.labourIds.has(row.labourId)
		)
		.map((row) => row.id);
	if (gone.length > 0) tx.delete(mentions).where(inArray(mentions.id, gone)).run();

	const keptLabours = new Set(held.map((row) => row.labourId));
	const keptUsers = new Set(held.map((row) => row.userId));
	const row = {
		sourceLabourId: input.sourceLabourId,
		commentId: input.commentId,
		authorId: input.authorId,
		firstSeenAt: input.firstSeenAt
	};
	for (const labourId of targets.labourIds) {
		if (!keptLabours.has(labourId))
			tx.insert(mentions)
				.values({ ...row, labourId })
				.run();
	}
	for (const userId of targets.userIds) {
		if (!keptUsers.has(userId))
			tx.insert(mentions)
				.values({ ...row, userId })
				.run();
	}
}

// Mentions of the Labour in other Labours' text, newest first.
export function readMentions(db: Handle, labourId: number, limit = MENTIONS_SHOWN): MentionView[] {
	return db
		.select({
			sourceLabourId: mentions.sourceLabourId,
			commentId: mentions.commentId,
			authorId: mentions.authorId,
			firstSeenAt: mentions.firstSeenAt
		})
		.from(mentions)
		.where(eq(mentions.labourId, labourId))
		.orderBy(desc(mentions.firstSeenAt), desc(mentions.id))
		.limit(limit)
		.all();
}
