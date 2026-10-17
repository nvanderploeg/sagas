import { asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { comments } from '../db/schema.ts';
import { refreshMentions } from '../agent/mentions.ts';
import { refreshLabourText } from '../agent/search.ts';
import { DomainError } from './errors.ts';
import { getLabour } from './lookup.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export type CommentView = typeof comments.$inferSelect;

export const COMMENT_MAX = 20_000;

// Oldest first.
export function listComments(db: Handle, labourId: number): CommentView[] {
	return db
		.select()
		.from(comments)
		.where(eq(comments.labourId, labourId))
		.orderBy(asc(comments.id))
		.all();
}

export function addComment(db: Db, actor: Actor, labourId: number, body: string): CommentView {
	return write(db, actor, (tx) => {
		getLabour(tx, labourId);
		const comment = tx
			.insert(comments)
			.values({
				labourId,
				authorId: actor.id,
				body: requireText(body, 'Comment', COMMENT_MAX)
			})
			.returning()
			.get();
		refreshLabourText(tx, labourId);
		refreshMentions(tx, {
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
function ownComment(tx: Handle, actor: Actor, id: number): CommentView {
	const row = tx.select().from(comments).where(eq(comments.id, id)).get();
	if (row === undefined) throw new DomainError('not_found', 'Comment not found');
	if (row.authorId !== actor.id) {
		throw new DomainError('forbidden', "Only a Comment's author can change it");
	}
	return row;
}

export function editComment(db: Db, actor: Actor, id: number, body: string): CommentView {
	return write(db, actor, (tx) => {
		const current = ownComment(tx, actor, id);
		const next = requireText(body, 'Comment', COMMENT_MAX);
		if (next === current.body) return { value: current, events: [] };
		const comment = tx
			.update(comments)
			.set({ body: next, updatedAt: new Date() })
			.where(eq(comments.id, id))
			.returning()
			.get();
		refreshLabourText(tx, comment.labourId);
		refreshMentions(tx, {
			sourceLabourId: comment.labourId,
			commentId: comment.id,
			text: comment.body,
			authorId: comment.authorId,
			firstSeenAt: comment.updatedAt!
		});
		return { value: comment, events: [{ type: 'labour.comment_edited', data: { comment } }] };
	});
}

export function deleteComment(db: Db, actor: Actor, id: number): CommentView {
	return write(db, actor, (tx) => {
		const comment = ownComment(tx, actor, id);
		tx.delete(comments).where(eq(comments.id, id)).run();
		refreshLabourText(tx, comment.labourId);
		return {
			value: comment,
			events: [{ type: 'labour.comment_deleted', data: { id, labourId: comment.labourId } }]
		};
	});
}
