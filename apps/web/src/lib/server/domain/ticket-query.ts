import { and, asc, count, eq, isNull, type SQL } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questTickets, states, tickets } from '../db/schema.ts';
import { selectTicketViews, toTicketView, type TicketView } from './ticket-view.ts';

// `null` for assigneeId or parentId matches Tickets without one.
export type TicketFilter = {
	projectId?: number;
	stateId?: number;
	substateId?: number;
	ownerId?: number;
	assigneeId?: number | null;
	parentId?: number | null;
	closed?: boolean;
	questId?: number;
};

export type TicketPage = { tickets: TicketView[]; total: number };

function conditions(filter: TicketFilter): SQL | undefined {
	const where: SQL[] = [];
	if (filter.projectId !== undefined) where.push(eq(tickets.projectId, filter.projectId));
	if (filter.stateId !== undefined) where.push(eq(tickets.stateId, filter.stateId));
	if (filter.substateId !== undefined) where.push(eq(tickets.substateId, filter.substateId));
	if (filter.ownerId !== undefined) where.push(eq(tickets.ownerId, filter.ownerId));
	if (filter.assigneeId !== undefined) {
		where.push(
			filter.assigneeId === null
				? isNull(tickets.assigneeId)
				: eq(tickets.assigneeId, filter.assigneeId)
		);
	}
	if (filter.parentId !== undefined) {
		where.push(
			filter.parentId === null ? isNull(tickets.parentId) : eq(tickets.parentId, filter.parentId)
		);
	}
	if (filter.closed !== undefined) where.push(eq(states.isClosed, filter.closed));
	if (filter.questId !== undefined) where.push(eq(questTickets.questId, filter.questId));
	return where.length > 0 ? and(...where) : undefined;
}

export function queryTickets(
	db: Handle,
	filter: TicketFilter,
	page: { offset: number; limit: number }
): TicketPage {
	const where = conditions(filter);
	const inQuest = filter.questId !== undefined;

	const rows = inQuest
		? selectTicketViews(db)
				.innerJoin(questTickets, eq(questTickets.ticketId, tickets.id))
				.where(where)
				.orderBy(asc(questTickets.rank))
		: selectTicketViews(db)
				.where(where)
				.orderBy(asc(tickets.projectId), asc(states.position), asc(tickets.rank));

	const counted = db
		.select({ n: count() })
		.from(tickets)
		.innerJoin(states, eq(states.id, tickets.stateId));
	const total = inQuest
		? counted.innerJoin(questTickets, eq(questTickets.ticketId, tickets.id)).where(where).get()
		: counted.where(where).get();

	return {
		tickets: rows.limit(page.limit).offset(page.offset).all().map(toTicketView),
		total: total?.n ?? 0
	};
}
