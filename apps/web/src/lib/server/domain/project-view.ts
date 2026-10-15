import type { Handle } from '../db/client.ts';
import { getProject } from './lookup.ts';
import { listStates, listSubstates } from './states.ts';
import type { EventSpec } from './write.ts';

export type ProjectView = ReturnType<typeof readProject>;

export function readProject(db: Handle, projectId: number) {
	const project = getProject(db, projectId);
	const states = listStates(db, projectId).map((state) => ({
		...state,
		substates: listSubstates(db, state.id)
	}));
	return { ...project, states };
}

export function configEvent(
	db: Handle,
	type: EventSpec['type'],
	entityIds: { projectId: number; stateId?: number; substateId?: number }
): EventSpec {
	return {
		type,
		entityIds,
		projectIds: [entityIds.projectId],
		snapshot: readProject(db, entityIds.projectId)
	};
}
