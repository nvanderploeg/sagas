import type { events } from '../db/schema.ts';

export const EVENT_TYPES = [
	'project.created',
	'project.updated',
	'project.deleted',
	'state.created',
	'state.updated',
	'state.deleted',
	'substate.created',
	'substate.updated',
	'substate.deleted',
	'ticket.created',
	'ticket.updated',
	'ticket.moved',
	'ticket.ranked',
	'ticket.reparented',
	'ticket.deleted'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EntityIds = {
	projectId?: number;
	stateId?: number;
	substateId?: number;
	ticketId?: number;
	ticketIds?: number[];
	questId?: number;
};

// The snapshot is the JSON form of the entity's read shape: dates arrive as ISO strings.
export type WorkloadEvent = typeof events.$inferSelect;
