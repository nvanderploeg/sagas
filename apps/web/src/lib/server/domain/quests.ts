import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { questTickets, quests, states, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { getTicket, requireUser } from './lookup.ts';
import { rankAt, type Placement } from './rank.ts';
import {
	DESCRIPTION_MAX,
	listChildren,
	selectTicketViews,
	toTicketView,
	type TicketView
} from './tickets.ts';
import { requireText } from './validate.ts';
import { write, type Actor, type EventSpec } from './write.ts';

export type Quest = typeof quests.$inferSelect;
export type QuestProgress = { closed: number; total: number };

export type QuestView = Quest & { ticketIds: number[]; progress: QuestProgress };

export type QuestSpec = { name: string; description?: string; ownerId: number };
export type QuestPatch = Partial<QuestSpec>;

function getQuest(db: Handle, questId: number): Quest {
	const row = db.select().from(quests).where(eq(quests.id, questId)).get();
	if (row === undefined) throw new DomainError('not_found', 'Quest not found');
	return row;
}

function membersOf(db: Handle, questId: number) {
	return db
		.select({ id: questTickets.ticketId, rank: questTickets.rank })
		.from(questTickets)
		.where(eq(questTickets.questId, questId))
		.orderBy(asc(questTickets.rank))
		.all();
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

export function readQuest(db: Handle, questId: number): QuestView {
	const quest = getQuest(db, questId);
	return {
		...quest,
		ticketIds: membersOf(db, questId).map((member) => member.id),
		progress: questProgress(db, questId)
	};
}

export function listQuests(db: Handle): QuestView[] {
	return db
		.select({ id: quests.id })
		.from(quests)
		.orderBy(asc(quests.id))
		.all()
		.map((row) => readQuest(db, row.id));
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

function questEvent(
	db: Handle,
	type: EventSpec['type'],
	questId: number,
	entityIds: { ticketId?: number; ticketIds?: number[] } = {},
	alsoAffects: number[] = []
): EventSpec {
	const snapshot = readQuest(db, questId);
	return {
		type,
		entityIds: { questId, ...entityIds },
		projectIds: [...projectsOf(db, snapshot.ticketIds), ...alsoAffects],
		snapshot
	};
}

function projectsOf(db: Handle, ticketIds: number[]): number[] {
	if (ticketIds.length === 0) return [];
	return db
		.selectDistinct({ projectId: tickets.projectId })
		.from(tickets)
		.where(inArray(tickets.id, ticketIds))
		.all()
		.map((row) => row.projectId);
}

function touch(db: Handle, questId: number): void {
	db.update(quests).set({ updatedAt: new Date() }).where(eq(quests.id, questId)).run();
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
		const quest = tx.insert(quests).values({ name, description, ownerId }).returning().get();
		const event = questEvent(tx, 'quest.created', quest.id);
		return { value: event.snapshot as QuestView, event };
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
		if (!changed) return { value: readQuest(tx, questId), event: null };
		tx.update(quests)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(quests.id, questId))
			.run();
		const event = questEvent(tx, 'quest.updated', questId);
		return { value: event.snapshot as QuestView, event };
	});
}

export function deleteQuest(db: Db, actor: Actor, questId: number): void {
	write(db, actor, (tx) => {
		getQuest(tx, questId);
		const projectIds = projectsOf(
			tx,
			membersOf(tx, questId).map((member) => member.id)
		);
		tx.delete(quests).where(eq(quests.id, questId)).run();
		return {
			value: undefined,
			event: { type: 'quest.deleted', entityIds: { questId }, projectIds, snapshot: null }
		};
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
		touch(tx, questId);
		const event = questEvent(tx, 'quest.tickets_added', questId, { ticketIds: [ticketId] });
		return { value: event.snapshot as QuestView, event };
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
		touch(tx, questId);
		const event = questEvent(tx, 'quest.tickets_added', questId, { ticketIds: adding });
		return { value: event.snapshot as QuestView, event };
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
		touch(tx, questId);
		const event = questEvent(tx, 'quest.ticket_removed', questId, { ticketId }, [
			getTicket(tx, ticketId).projectId
		]);
		return { value: event.snapshot as QuestView, event };
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
		if (rank === member.rank) return { value: readQuest(tx, questId), event: null };
		tx.update(questTickets)
			.set({ rank })
			.where(and(eq(questTickets.questId, questId), eq(questTickets.ticketId, ticketId)))
			.run();
		touch(tx, questId);
		const event = questEvent(tx, 'quest.ticket_ranked', questId, { ticketId });
		return { value: event.snapshot as QuestView, event };
	});
}

function insertMember(db: Handle, questId: number, ticketId: number, rank: string): void {
	db.insert(questTickets).values({ questId, ticketId, rank }).run();
}
