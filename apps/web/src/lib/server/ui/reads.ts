import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { projectKeys, projects, quests, states, tickets } from '../db/schema.ts';
import { getProject } from '../domain/lookup.ts';
import { listProjects, readProject, type Project, type ProjectView } from '../domain/projects.ts';
import { listQuests, listTicketQuests, readQuest, type QuestView } from '../domain/quests.ts';
import {
	listChildren,
	readTicket,
	resolveTicketKey,
	selectTicketViews,
	toTicketView,
	type TicketView
} from '../domain/tickets.ts';
import type { Json } from '../events/types.ts';

// Page loads hand the client the JSON form Events carry, so loaded and live data share one shape.
export function toJson<T>(value: T): Json<T> {
	return JSON.parse(JSON.stringify(value)) as Json<T>;
}

// Resolves a current or former Project key, in any case.
export function findProjectByKey(db: Handle, input: string): Project | null {
	const row = db
		.select({ projectId: projectKeys.projectId })
		.from(projectKeys)
		.where(eq(projectKeys.key, input.trim().toUpperCase()))
		.get();
	return row ? getProject(db, row.projectId) : null;
}

export function readAllProjects(db: Handle): ProjectView[] {
	return listProjects(db).map((p) => readProject(db, p.id));
}

export function readHome(db: Handle, userId: number) {
	const mine = selectTicketViews(db)
		.where(
			and(
				or(eq(tickets.ownerId, userId), eq(tickets.assigneeId, userId)),
				eq(states.isClosed, false)
			)
		)
		.orderBy(asc(tickets.id))
		.all()
		.map(toTicketView);
	const owned = db
		.select({ id: quests.id })
		.from(quests)
		.where(eq(quests.ownerId, userId))
		.orderBy(asc(quests.id))
		.all();
	return { projects: readAllProjects(db), mine, quests: owned.map((q) => readQuest(db, q.id)) };
}

export function readTicketPage(db: Handle, ticketId: number) {
	const ticket = readTicket(db, ticketId);
	return {
		ticket,
		parent: ticket.parentId === null ? null : readTicket(db, ticket.parentId),
		children: listChildren(db, ticketId),
		projects: readAllProjects(db),
		quests: db
			.select({ id: quests.id, name: quests.name })
			.from(quests)
			.orderBy(asc(quests.id))
			.all(),
		memberOf: listTicketQuests(db, ticketId).map((q) => q.id)
	};
}

export function readQuestPage(db: Handle, questId: number) {
	return { quest: readQuest(db, questId), projects: readAllProjects(db) };
}

export function readQuestList(db: Handle): { quests: QuestView[]; projects: ProjectView[] } {
	return { quests: listQuests(db), projects: readAllProjects(db) };
}

export type TicketMatch = TicketView & { childCount: number };

// Matches a Ticket key, current or former, then key prefixes and titles.
export function searchTickets(db: Handle, input: string, limit = 12): TicketMatch[] {
	const query = input.trim();
	if (query === '') return [];
	const exact = resolveTicketKey(db, query);
	const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const keyPrefix = `${query.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const found = selectTicketViews(db)
		.where(
			or(
				sql`${tickets.title} LIKE ${pattern} ESCAPE '\\'`,
				sql`(${projects.key} || '-' || ${tickets.number}) LIKE ${keyPrefix} ESCAPE '\\'`
			)
		)
		.orderBy(asc(tickets.id))
		.limit(limit)
		.all()
		.map(toTicketView);
	const matches = exact ? [exact, ...found.filter((t) => t.id !== exact.id)] : found;
	const shown = matches.slice(0, limit);
	return withChildCounts(db, shown);
}

function withChildCounts(db: Handle, list: TicketView[]): TicketMatch[] {
	if (list.length === 0) return [];
	const counts = new Map(
		db
			.select({ parentId: tickets.parentId, n: count() })
			.from(tickets)
			.where(
				inArray(
					tickets.parentId,
					list.map((t) => t.id)
				)
			)
			.groupBy(tickets.parentId)
			.all()
			.map((row) => [row.parentId, row.n])
	);
	return list.map((t) => ({ ...t, childCount: counts.get(t.id) ?? 0 }));
}
