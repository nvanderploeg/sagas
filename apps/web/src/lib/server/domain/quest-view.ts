import { asc, count, eq, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questTickets, quests, states, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { selectTicketViews, toTicketView, type TicketView } from './ticket-view.ts';

export type Quest = typeof quests.$inferSelect;
export type QuestProgress = { closed: number; total: number };

// `tickets` are the members in Quest order.
export type QuestView = Quest & { tickets: TicketView[]; progress: QuestProgress };

export function getQuest(db: Handle, questId: number): Quest {
	const row = db.select().from(quests).where(eq(quests.id, questId)).get();
	if (row === undefined) throw new DomainError('not_found', 'Quest not found');
	return row;
}

// Progress follows the Quest definition in CONTEXT.md.
export function questProgress(db: Handle, questId: number): QuestProgress {
	getQuest(db, questId);
	const row = db
		.select({
			total: count(),
			closed: sql<number>`coalesce(sum(${states.isClosed}), 0)`
		})
		.from(questTickets)
		.innerJoin(tickets, eq(tickets.id, questTickets.ticketId))
		.innerJoin(states, eq(states.id, tickets.stateId))
		.where(eq(questTickets.questId, questId))
		.get();
	return { closed: Number(row?.closed ?? 0), total: row?.total ?? 0 };
}

export function listQuestTickets(db: Handle, questId: number): TicketView[] {
	getQuest(db, questId);
	return selectTicketViews(db)
		.innerJoin(questTickets, eq(questTickets.ticketId, tickets.id))
		.where(eq(questTickets.questId, questId))
		.orderBy(asc(questTickets.rank))
		.all()
		.map(toTicketView);
}

export function readQuest(db: Handle, questId: number): QuestView {
	return {
		...getQuest(db, questId),
		tickets: listQuestTickets(db, questId),
		progress: questProgress(db, questId)
	};
}

export function touchQuest(db: Handle, questId: number): void {
	db.update(quests).set({ updatedAt: new Date() }).where(eq(quests.id, questId)).run();
}
