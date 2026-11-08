import { currentVia } from '#lib/server/auth/via.ts';
import { asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { comments } from '../db/schema.ts';
import { refreshMentions } from '../agent/mentions.ts';
import { refreshLabourText } from '../agent/search.ts';
import { DomainError } from './errors.ts';
import { getLabour } from './lookup.ts';
import { requireText } from './validate.ts';
import { requireRealmRole } from './access.ts';
import { write, type Actor } from './write.ts';

export type CommentView = typeof comments.$inferSelect;

export const COMMENT_MAX = 20_000;

// Oldest first.
export async function listComments(db: Handle, labourId: number): Promise<CommentView[]> {
	return await db
		.select()
		.from(comments)
		.where(eq(comments.labourId, labourId))
		.orderBy(asc(comments.id));
}

export async function addComment(
	db: Db,
	actor: Actor,
	labourId: number,
	body: string
): Promise<CommentView> {
	return write(db, actor, async (tx) => {
		await requireRealmRole(tx, actor, (await getLabour(tx, labourId)).realmId, 'editor');
		const comment = (
			await tx
				.insert(comments)
				.values({
					labourId,
					authorId: actor.id,
					via: currentVia(),
					body: requireText(body, 'Comment', COMMENT_MAX)
				})
				.returning()
		)[0];
		await refreshLabourText(tx, labourId);
		await refreshMentions(tx, {
			sourceLabourId: labourId,
			commentId: comment.id,
			text: comment.body,
			authorId: comment.authorId,
			firstSeenAt: comment.createdAt
		});
		return { value: comment, events: [{ type: 'labour.commented', data: { comment } }] };
	});
}

// Only the author changes a Comment.
async function ownComment(tx: Handle, actor: Actor, id: number): Promise<CommentView> {
	const row = (await tx.select().from(comments).where(eq(comments.id, id)).limit(1))[0];
	if (row === undefined) throw new DomainError('not_found', 'Comment not found');
	await requireRealmRole(tx, actor, (await getLabour(tx, row.labourId)).realmId, 'editor');
	if (row.authorId !== actor.id) {
		throw new DomainError('forbidden', "Only a Comment's author can change it");
	}
	return row;
}

export async function editComment(
	db: Db,
	actor: Actor,
	id: number,
	body: string
): Promise<CommentView> {
	return write(db, actor, async (tx) => {
		const current = await ownComment(tx, actor, id);
		const next = requireText(body, 'Comment', COMMENT_MAX);
		if (next === current.body) return { value: current, events: [] };
		const comment = (
			await tx
				.update(comments)
				.set({ body: next, updatedAt: new Date() })
				.where(eq(comments.id, id))
				.returning()
		)[0];
		await refreshLabourText(tx, comment.labourId);
		await refreshMentions(tx, {
			sourceLabourId: comment.labourId,
			commentId: comment.id,
			text: comment.body,
			authorId: comment.authorId,
			firstSeenAt: comment.updatedAt!
		});
		return { value: comment, events: [{ type: 'labour.comment_edited', data: { comment } }] };
	});
}

export async function deleteComment(db: Db, actor: Actor, id: number): Promise<CommentView> {
	return write(db, actor, async (tx) => {
		const comment = await ownComment(tx, actor, id);
		await tx.delete(comments).where(eq(comments.id, id));
		await refreshLabourText(tx, comment.labourId);
		return {
			value: comment,
			events: [{ type: 'labour.comment_deleted', data: { id, labourId: comment.labourId } }]
		};
	});
}
