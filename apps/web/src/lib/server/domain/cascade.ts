import { and, asc, inArray, not, type SQL } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questTickets, tickets } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { readQuest, touchQuest } from './quest-view.ts';
import { readTicket } from './ticket-view.ts';

export type Fallout = { orphans: number[]; quests: Map<number, number[]> };

// Call before the delete. Detach Children here, not by the foreign key, so their updatedAt moves.
export function prepareTicketDelete(tx: Handle, doomed: SQL): Fallout {
	const doomedIds = tx.select({ id: tickets.id }).from(tickets).where(doomed);
	const orphaned = and(inArray(tickets.parentId, doomedIds), not(inArray(tickets.id, doomedIds)));
	const orphans = tx
		.select({ id: tickets.id })
		.from(tickets)
		.where(orphaned)
		.orderBy(asc(tickets.id))
		.all()
		.map((row) => row.id);
	tx.update(tickets).set({ parentId: null, updatedAt: new Date() }).where(orphaned).run();

	const quests = new Map<number, number[]>();
	const memberships = tx
		.select({ questId: questTickets.questId, ticketId: questTickets.ticketId })
		.from(questTickets)
		.where(inArray(questTickets.ticketId, doomedIds))
		.orderBy(asc(questTickets.questId), asc(questTickets.rank))
		.all();
	for (const { questId, ticketId } of memberships) {
		quests.set(questId, [...(quests.get(questId) ?? []), ticketId]);
	}
	return { orphans, quests };
}

// Call after the delete.
export function falloutEvents(tx: Handle, fallout: Fallout): EventSpec[] {
	for (const questId of fallout.quests.keys()) touchQuest(tx, questId);
	return [
		...fallout.orphans.map((id): EventSpec => ({
			type: 'ticket.reparented',
			data: { ticket: readTicket(tx, id) }
		})),
		...[...fallout.quests].map(([questId, ticketIds]): EventSpec => ({
			type: 'quest.tickets_removed',
			data: { quest: readQuest(tx, questId), ticketIds }
		}))
	];
}
