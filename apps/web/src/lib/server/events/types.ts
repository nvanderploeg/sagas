import type { ProjectView } from '../domain/project-view.ts';
import type { QuestView } from '../domain/quest-view.ts';
import type { TicketView } from '../domain/ticket-view.ts';

// The contract is docs/events.md: change both together.
//
// No Event lists the Projects it touches. Each names the entities it changed and carries their
// view after the write, and a client applies it to every view that shows those entities.
export type EventData = {
	'project.created': { project: ProjectView };
	'project.updated': { project: ProjectView };
	'project.deleted': { projectId: number; ticketIds: number[] };
	'state.created': { project: ProjectView; stateId: number };
	'state.updated': { project: ProjectView; stateId: number };
	'state.deleted': { project: ProjectView; stateId: number };
	'substate.created': { project: ProjectView; stateId: number; substateId: number };
	'substate.updated': { project: ProjectView; stateId: number; substateId: number };
	'substate.deleted': { project: ProjectView; stateId: number; substateId: number };
	'ticket.created': { ticket: TicketView };
	'ticket.updated': { ticket: TicketView };
	'ticket.moved': { ticket: TicketView };
	'ticket.reparented': { ticket: TicketView };
	'ticket.ranked': { id: number; stateId: number; rank: string };
	'ticket.rekeyed': {
		projectId: number;
		tickets: { id: number; previousKey: string; key: string }[];
	};
	'ticket.deleted': { id: number; projectId: number };
	'quest.created': { quest: QuestView };
	'quest.updated': { quest: QuestView };
	'quest.deleted': { id: number };
	'quest.tickets_added': { quest: QuestView; ticketIds: number[] };
	'quest.tickets_removed': { quest: QuestView; ticketIds: number[] };
	'quest.ticket_ranked': { quest: QuestView; ticketId: number };
};

export type EventType = keyof EventData;

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

export const EVENT_TYPES = Object.keys(TYPES) as [EventType, ...EventType[]];

export type EventActor = {
	id: number;
	kind: 'human' | 'agent';
	username: string;
	displayName: string;
};

// The JSON form of a value: dates arrive as ISO strings.
export type Json<T> = T extends Date
	? string
	: T extends (infer U)[]
		? Json<U>[]
		: T extends object
			? { [K in keyof T]: Json<T[K]> }
			: T;

export type EventSpec = { [K in EventType]: { type: K; data: EventData[K] } }[EventType];

export type WorkloadEvent = {
	[K in EventType]: {
		seq: number;
		type: K;
		actor: EventActor;
		createdAt: Date;
		data: Json<EventData[K]>;
	};
}[EventType];
