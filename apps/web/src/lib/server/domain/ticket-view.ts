import { eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { projects, states, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { formatTicketKey } from './keys.ts';

export type Ticket = typeof tickets.$inferSelect;

// `closed` is whether the Ticket's State is Closed.
export type TicketView = Ticket & { key: string; closed: boolean };

export function selectTicketViews(db: Handle) {
	return db
		.select({ ticket: tickets, projectKey: projects.key, closed: states.isClosed })
		.from(tickets)
		.innerJoin(projects, eq(projects.id, tickets.projectId))
		.innerJoin(states, eq(states.id, tickets.stateId));
}

export function toTicketView(row: {
	ticket: Ticket;
	projectKey: string;
	closed: boolean;
}): TicketView {
	return {
		...row.ticket,
		key: formatTicketKey(row.projectKey, row.ticket.number),
		closed: row.closed
	};
}

export function readTicket(db: Handle, ticketId: number): TicketView {
	const row = selectTicketViews(db).where(eq(tickets.id, ticketId)).get();
	if (row === undefined) throw new DomainError('not_found', 'Ticket not found');
	return toTicketView(row);
}

export function ticketName(db: Handle): (id: number) => string {
	return (id) => {
		const row = selectTicketViews(db).where(eq(tickets.id, id)).get();
		return row === undefined ? `Ticket ${id}` : toTicketView(row).key;
	};
}
