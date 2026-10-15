import type { ProjectView } from '#lib/server/domain/project-view.ts';
import type { QuestView } from '#lib/server/domain/quest-view.ts';
import type { TicketView } from '#lib/server/domain/ticket-view.ts';
import type { EventActor, EventType, Json, WorkloadEvent } from '#lib/server/events/types.ts';

export type { EventActor, EventType, Json };

export type Ticket = Json<TicketView>;
export type Project = Json<ProjectView>;
export type State = Project['states'][number];
export type Substate = State['substates'][number];
export type Quest = Json<QuestView>;
export type LiveEvent = Json<WorkloadEvent>;

export type QuestOption = { id: number; name: string };

export type BoardView = { project: Project; tickets: Ticket[] };

// `mine`: the User's open Tickets, owned or assigned. `quests`: the Quests the User owns.
export type HomeView = { projects: Project[]; mine: Ticket[]; quests: Quest[] };

export type QuestPageView = { quest: Quest; projects: Project[] };

export type QuestListView = { quests: Quest[]; projects: Project[] };

// `memberOf` lists the ids of the Quests holding the Ticket, ascending.
export type TicketPageView = {
	ticket: Ticket;
	parent: Ticket | null;
	children: Ticket[];
	projects: Project[];
	quests: QuestOption[];
	memberOf: number[];
};

export type SettingsView = { project: Project };

// Every type, so the client can listen for each named SSE event; the compiler keeps it complete.
const TYPES: { [K in EventType]: true } = {
	'project.created': true,
	'project.updated': true,
	'project.deleted': true,
	'state.created': true,
	'state.updated': true,
	'state.deleted': true,
	'substate.created': true,
	'substate.updated': true,
	'substate.deleted': true,
	'ticket.created': true,
	'ticket.updated': true,
	'ticket.moved': true,
	'ticket.reparented': true,
	'ticket.ranked': true,
	'ticket.rekeyed': true,
	'ticket.deleted': true,
	'quest.created': true,
	'quest.updated': true,
	'quest.deleted': true,
	'quest.tickets_added': true,
	'quest.tickets_removed': true,
	'quest.ticket_ranked': true
};

export const EVENT_TYPES = Object.keys(TYPES) as EventType[];
