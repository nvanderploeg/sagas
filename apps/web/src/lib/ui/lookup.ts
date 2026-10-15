import type { Project, State, Substate, Ticket } from '../live/types.ts';

export const FALLBACK_STATE = { label: 'Unknown', color: '#9ca3af', icon: 'question' };

export function stateOf(
	projects: Project[],
	ticket: Pick<Ticket, 'projectId' | 'stateId' | 'substateId'>
): { project: Project | undefined; state: State | undefined; substate: Substate | undefined } {
	const project = projects.find((p) => p.id === ticket.projectId);
	const state = project?.states.find((s) => s.id === ticket.stateId);
	const substate = state?.substates.find((s) => s.id === ticket.substateId);
	return { project, state, substate };
}

export const byRecent = (a: { updatedAt: string }, b: { updatedAt: string }) =>
	a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
