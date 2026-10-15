import { asc, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { tickets } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { getProject, getState } from './lookup.ts';
import { listStates, listSubstates } from './states.ts';
import { selectTicketViews, toTicketView, type TicketView } from './ticket-view.ts';

export type ProjectView = ReturnType<typeof readProject>;

export type BoardView = { project: ProjectView; tickets: TicketView[] };

// Never include ticketCounter: every Ticket created moves it, and no Project Event announces that.
export function readProject(db: Handle, projectId: number) {
	const { id, name, key, initialStateId } = getProject(db, projectId);
	const states = listStates(db, projectId).map((state) => ({
		...state,
		substates: listSubstates(db, state.id)
	}));
	return { id, name, key, initialStateId, states };
}

// Tickets come grouped by State and in Rank order within each.
export function readBoard(db: Handle, projectId: number): BoardView {
	return {
		project: readProject(db, projectId),
		tickets: selectTicketViews(db)
			.where(eq(tickets.projectId, projectId))
			.orderBy(asc(tickets.stateId), asc(tickets.rank))
			.all()
			.map(toTicketView)
	};
}

export function projectEvent(
	db: Handle,
	type: 'project.created' | 'project.updated',
	projectId: number
): EventSpec {
	return { type, data: { project: readProject(db, projectId) } };
}

export function stateEvent(
	db: Handle,
	type: 'state.created' | 'state.updated' | 'state.deleted',
	projectId: number,
	stateId: number
): EventSpec {
	return { type, data: { project: readProject(db, projectId), stateId } };
}

export function substateEvent(
	db: Handle,
	type: 'substate.created' | 'substate.updated' | 'substate.deleted',
	substate: { id: number; stateId: number }
): EventSpec {
	const { projectId } = getState(db, substate.stateId);
	return {
		type,
		data: {
			project: readProject(db, projectId),
			stateId: substate.stateId,
			substateId: substate.id
		}
	};
}
