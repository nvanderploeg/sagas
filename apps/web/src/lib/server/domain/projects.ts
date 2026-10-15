import { asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { projectKeys, projects, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { getProject, getState } from './lookup.ts';
import { configEvent } from './project-view.ts';
import { CLOSED_STATE, insertState, type StyleSpec } from './states.ts';
import { formatTicketKey, normalizeProjectKey } from './keys.ts';
import { recordTicketKey } from './tickets.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export type Project = typeof projects.$inferSelect;
export { readProject, type ProjectView } from './project-view.ts';

export function listProjects(db: Handle) {
	return db.select().from(projects).orderBy(asc(projects.id)).all();
}

export function createProject(
	db: Db,
	actor: Actor,
	input: { name: string; key: string; initialState: StyleSpec }
): Project {
	const name = requireText(input.name, 'Project name', 120);
	const key = normalizeProjectKey(input.key);
	return write(db, actor, (tx) => {
		assertKeyAvailable(tx, key, null);
		const project = tx.insert(projects).values({ name, key }).returning().get();
		tx.insert(projectKeys).values({ key, projectId: project.id }).run();
		insertState(tx, project.id, CLOSED_STATE, { closed: true });
		const initial = insertState(tx, project.id, input.initialState);
		const value = tx
			.update(projects)
			.set({ initialStateId: initial.id })
			.where(eq(projects.id, project.id))
			.returning()
			.get();
		return { value, event: configEvent(tx, 'project.created', { projectId: project.id }) };
	});
}

export function updateProject(
	db: Db,
	actor: Actor,
	projectId: number,
	patch: { name: string }
): Project {
	return write(db, actor, (tx) => {
		const project = getProject(tx, projectId);
		const name = requireText(patch.name, 'Project name', 120);
		if (name === project.name) return { value: project, event: null };
		const value = tx
			.update(projects)
			.set({ name })
			.where(eq(projects.id, projectId))
			.returning()
			.get();
		return { value, event: configEvent(tx, 'project.updated', { projectId }) };
	});
}

export function renameProjectKey(db: Db, actor: Actor, projectId: number, input: string): Project {
	return write(db, actor, (tx) => {
		const project = getProject(tx, projectId);
		const key = normalizeProjectKey(input);
		if (key === project.key) return { value: project, event: null };
		assertKeyAvailable(tx, key, projectId);

		tx.insert(projectKeys).values({ key, projectId }).onConflictDoNothing().run();
		const held = tx
			.select({ id: tickets.id, number: tickets.number })
			.from(tickets)
			.where(eq(tickets.projectId, projectId))
			.all();
		for (const ticket of held) recordTicketKey(tx, ticket.id, formatTicketKey(key, ticket.number));
		const value = tx
			.update(projects)
			.set({ key })
			.where(eq(projects.id, projectId))
			.returning()
			.get();
		return { value, event: configEvent(tx, 'project.updated', { projectId }) };
	});
}

export function setInitialState(db: Db, actor: Actor, projectId: number, stateId: number): Project {
	return write(db, actor, (tx) => {
		const project = getProject(tx, projectId);
		const state = getState(tx, stateId);
		if (state.projectId !== projectId) {
			throw new DomainError('invalid', 'The Initial State must belong to the Project');
		}
		if (state.isClosed) throw new DomainError('invalid', 'The Initial State cannot be Closed');
		if (project.initialStateId === stateId) return { value: project, event: null };
		const value = tx
			.update(projects)
			.set({ initialStateId: stateId })
			.where(eq(projects.id, projectId))
			.returning()
			.get();
		return { value, event: configEvent(tx, 'project.updated', { projectId }) };
	});
}

export function deleteProject(db: Db, actor: Actor, projectId: number): void {
	write(db, actor, (tx) => {
		getProject(tx, projectId);
		tx.delete(projects).where(eq(projects.id, projectId)).run();
		return {
			value: undefined,
			event: {
				type: 'project.deleted',
				entityIds: { projectId },
				projectIds: [projectId],
				snapshot: null
			}
		};
	});
}

function assertKeyAvailable(db: Handle, key: string, selfId: number | null): void {
	const holder = db.select().from(projectKeys).where(eq(projectKeys.key, key)).get();
	if (holder && holder.projectId !== selfId) {
		throw new DomainError('conflict', `Project key ${key} is already in use`);
	}
}
