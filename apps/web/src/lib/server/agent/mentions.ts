import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
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

export type MentionTargets = { labourIds: Set<number>; userIds: Set<number> };

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

// The Labours and Users a text names, by Labour key, Alias or username.
export async function mentionTargets(tx: Handle, text: string): Promise<MentionTargets> {
	const found = scan(text);
	const labourIds = new Set<number>();
	if (found.keys.length > 0) {
		const rows = await tx
			.select({ labourId: labourKeys.labourId })
			.from(labourKeys)
			.where(inArray(labourKeys.key, found.keys))
			.orderBy(asc(labourKeys.key));
		for (const row of rows) labourIds.add(row.labourId);
	}

	const userIds = new Set<number>();
	if (found.names.length > 0) {
		const candidates = [...new Set(found.names.flatMap((name) => [name.exact, name.trimmed]))];
		const byName = new Map(
			(
				await tx
					.select({ id: users.id, username: users.username })
					.from(users)
					.where(inArray(users.username, candidates))
			).map((row) => [row.username, row.id])
		);
		for (const { exact, trimmed } of found.names) {
			const id = byName.get(exact) ?? byName.get(trimmed);
			if (id !== undefined) userIds.add(id);
		}
	}
	return { labourIds, userIds };
}

// Leave kept rows untouched: their firstSeenAt and authorId must survive edits.
export async function refreshMentions(tx: Handle, input: MentionText): Promise<void> {
	const targets = await mentionTargets(tx, input.text);
	targets.labourIds.delete(input.sourceLabourId);
	const held = await tx
		.select()
		.from(mentions)
		.where(
			and(
				eq(mentions.sourceLabourId, input.sourceLabourId),
				input.commentId === null
					? isNull(mentions.commentId)
					: eq(mentions.commentId, input.commentId)
			)
		);

	const gone = held
		.filter((row) =>
			row.labourId === null
				? !targets.userIds.has(row.userId!)
				: !targets.labourIds.has(row.labourId)
		)
		.map((row) => row.id);
	if (gone.length > 0) await tx.delete(mentions).where(inArray(mentions.id, gone));

	const keptLabours = new Set(held.map((row) => row.labourId));
	const keptUsers = new Set(held.map((row) => row.userId));
	const row = {
		sourceLabourId: input.sourceLabourId,
		commentId: input.commentId,
		authorId: input.authorId,
		firstSeenAt: input.firstSeenAt
	};
	for (const labourId of targets.labourIds) {
		if (!keptLabours.has(labourId)) await tx.insert(mentions).values({ ...row, labourId });
	}
	for (const userId of targets.userIds) {
		if (!keptUsers.has(userId)) await tx.insert(mentions).values({ ...row, userId });
	}
}

// Mentions of the Labour in other Labours' text, newest first.
export async function readMentions(
	db: Handle,
	labourId: number,
	limit = MENTIONS_SHOWN
): Promise<MentionView[]> {
	return await db
		.select({
			sourceLabourId: mentions.sourceLabourId,
			commentId: mentions.commentId,
			authorId: mentions.authorId,
			firstSeenAt: mentions.firstSeenAt
		})
		.from(mentions)
		.where(eq(mentions.labourId, labourId))
		.orderBy(desc(mentions.firstSeenAt), desc(mentions.id))
		.limit(limit);
}
