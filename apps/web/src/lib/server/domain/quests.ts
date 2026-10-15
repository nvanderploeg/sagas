import { and, asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { questTickets, quests } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { DomainError } from './errors.ts';
import { getTicket, requireUser } from './lookup.ts';
import { getQuest, readQuest, touchQuest, type Quest, type QuestView } from './quest-view.ts';
import { rankAt, type Placement } from './rank.ts';
import { DESCRIPTION_MAX, listChildren } from './tickets.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export {
	listQuestTickets,
	questProgress,
	readQuest,
	type Quest,
	type QuestProgress,
	type QuestView
} from './quest-view.ts';

export type QuestSpec = { name: string; description?: string; ownerId: number };
export type QuestPatch = Partial<QuestSpec>;

function membersOf(db: Handle, questId: number) {
	return db
		.select({ id: questTickets.ticketId, rank: questTickets.rank })
		.from(questTickets)
		.where(eq(questTickets.questId, questId))
		.orderBy(asc(questTickets.rank))
		.all();
}

export function listQuests(db: Handle): QuestView[] {
	return db
		.select({ id: quests.id })
		.from(quests)
		.orderBy(asc(quests.id))
		.all()
		.map((row) => readQuest(db, row.id));
}

export function listTicketQuests(db: Handle, ticketId: number): Quest[] {
	getTicket(db, ticketId);
	return db
		.select({ quest: quests })
		.from(questTickets)
		.innerJoin(quests, eq(quests.id, questTickets.questId))
		.where(eq(questTickets.ticketId, ticketId))
		.orderBy(asc(quests.id))
		.all()
		.map((row) => row.quest);
}

function questOutcome(
	db: Handle,
	questId: number,
	event: (quest: QuestView) => EventSpec
): { value: QuestView; events: EventSpec[] } {
	const quest = readQuest(db, questId);
	return { value: quest, events: [event(quest)] };
}

function checkDescription(value: string): string {
	if (value.length > DESCRIPTION_MAX) {
		throw new DomainError(
			'invalid',
			`Quest description must be at most ${DESCRIPTION_MAX} characters`
		);
	}
	return value;
}

export function createQuest(db: Db, actor: Actor, input: QuestSpec): QuestView {
	const name = requireText(input.name, 'Quest name', 120);
	const description = checkDescription(input.description ?? '');
	return write(db, actor, (tx) => {
		const ownerId = requireUser(tx, input.ownerId, 'Owner');
		const { id } = tx.insert(quests).values({ name, description, ownerId }).returning().get();
		return questOutcome(tx, id, (quest) => ({ type: 'quest.created', data: { quest } }));
	});
}

export function updateQuest(db: Db, actor: Actor, questId: number, patch: QuestPatch): QuestView {
	return write(db, actor, (tx) => {
		const quest = getQuest(tx, questId);
		const changes: Partial<typeof quests.$inferInsert> = {};
		if (patch.name !== undefined) changes.name = requireText(patch.name, 'Quest name', 120);
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) changes.ownerId = requireUser(tx, patch.ownerId, 'Owner');

		const changed = (Object.keys(changes) as (keyof Quest)[]).some(
			(key) => changes[key as keyof typeof changes] !== quest[key]
		);
		if (!changed) return { value: readQuest(tx, questId), events: [] };
		tx.update(quests)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(quests.id, questId))
			.run();
		return questOutcome(tx, questId, (quest) => ({ type: 'quest.updated', data: { quest } }));
	});
}

export function deleteQuest(db: Db, actor: Actor, questId: number): void {
	write(db, actor, (tx) => {
		getQuest(tx, questId);
		tx.delete(quests).where(eq(quests.id, questId)).run();
		return { value: undefined, events: [{ type: 'quest.deleted', data: { id: questId } }] };
	});
}

// Membership is explicit, per CONTEXT.md: never add the Ticket's Children here.
export function addQuestTicket(
	db: Db,
	actor: Actor,
	questId: number,
	ticketId: number,
	placement: Placement = 'bottom'
): QuestView {
	return write(db, actor, (tx) => {
		getQuest(tx, questId);
		getTicket(tx, ticketId);
		const members = membersOf(tx, questId);
		if (members.some((member) => member.id === ticketId)) {
			throw new DomainError('conflict', 'The Ticket is already in the Quest');
		}
		insertMember(tx, questId, ticketId, rankAt(members, { id: ticketId }, placement, 'Quest'));
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.tickets_added',
			data: { quest, ticketIds: [ticketId] }
		}));
	});
}

export function addQuestTicketWithChildren(
	db: Db,
	actor: Actor,
	questId: number,
	ticketId: number,
	placement: Placement = 'bottom'
): QuestView {
	return write(db, actor, (tx) => {
		getQuest(tx, questId);
		getTicket(tx, ticketId);
		const present = new Set(membersOf(tx, questId).map((member) => member.id));
		const adding = [ticketId, ...listChildren(tx, ticketId).map((child) => child.id)].filter(
			(id) => !present.has(id)
		);
		if (adding.length === 0) {
			throw new DomainError('conflict', 'The Ticket and its Children are already in the Quest');
		}
		let next = placement;
		for (const id of adding) {
			insertMember(tx, questId, id, rankAt(membersOf(tx, questId), { id }, next, 'Quest'));
			next = { after: id };
		}
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.tickets_added',
			data: { quest, ticketIds: adding }
		}));
	});
}

export function removeQuestTicket(
	db: Db,
	actor: Actor,
	questId: number,
	ticketId: number
): QuestView {
	return write(db, actor, (tx) => {
		getQuest(tx, questId);
		const removed = tx
			.delete(questTickets)
			.where(and(eq(questTickets.questId, questId), eq(questTickets.ticketId, ticketId)))
			.run();
		if (removed.changes === 0) throw new DomainError('not_found', 'The Ticket is not in the Quest');
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.tickets_removed',
			data: { quest, ticketIds: [ticketId] }
		}));
	});
}

export function rankQuestTicket(
	db: Db,
	actor: Actor,
	questId: number,
	ticketId: number,
	placement: Placement
): QuestView {
	return write(db, actor, (tx) => {
		getQuest(tx, questId);
		const members = membersOf(tx, questId);
		const member = members.find((m) => m.id === ticketId);
		if (member === undefined) throw new DomainError('not_found', 'The Ticket is not in the Quest');
		const rank = rankAt(members, member, placement, 'Quest');
		if (rank === member.rank) return { value: readQuest(tx, questId), events: [] };
		tx.update(questTickets)
			.set({ rank })
			.where(and(eq(questTickets.questId, questId), eq(questTickets.ticketId, ticketId)))
			.run();
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.ticket_ranked',
			data: { quest, ticketId }
		}));
	});
}

function insertMember(db: Handle, questId: number, ticketId: number, rank: string): void {
	db.insert(questTickets).values({ questId, ticketId, rank }).run();
}
