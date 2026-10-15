import { asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { projectKeys, projects, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { getProject, getState } from './lookup.ts';
import { CLOSED_STATE, insertState, type StyleSpec } from './states.ts';
import { formatTicketKey, normalizeProjectKey } from './keys.ts';
import { recordTicketKey } from './tickets.ts';
import { requireText } from './validate.ts';

export function listProjects(db: Handle) {
	return db.select().from(projects).orderBy(asc(projects.id)).all();
}

export function createProject(
	db: Db,
	input: { name: string; key: string; initialState: StyleSpec }
) {
	const name = requireText(input.name, 'Project name', 120);
	const key = normalizeProjectKey(input.key);
	return db.transaction((tx) => {
		assertKeyAvailable(tx, key, null);
		const project = tx.insert(projects).values({ name, key }).returning().get();
		tx.insert(projectKeys).values({ key, projectId: project.id }).run();
		insertState(tx, project.id, CLOSED_STATE, { closed: true });
		const initial = insertState(tx, project.id, input.initialState);
		return tx
			.update(projects)
			.set({ initialStateId: initial.id })
			.where(eq(projects.id, project.id))
			.returning()
			.get();
	});
}

export function updateProject(db: Db, projectId: number, patch: { name: string }) {
	return db.transaction((tx) => {
		getProject(tx, projectId);
		const name = requireText(patch.name, 'Project name', 120);
		return tx.update(projects).set({ name }).where(eq(projects.id, projectId)).returning().get();
	});
}

export function renameProjectKey(db: Db, projectId: number, input: string) {
	return db.transaction((tx) => {
		const project = getProject(tx, projectId);
		const key = normalizeProjectKey(input);
		if (key === project.key) return project;
		assertKeyAvailable(tx, key, projectId);

		tx.insert(projectKeys).values({ key, projectId }).onConflictDoNothing().run();
		const held = tx
			.select({ id: tickets.id, number: tickets.number })
			.from(tickets)
			.where(eq(tickets.projectId, projectId))
			.all();
		for (const ticket of held) recordTicketKey(tx, ticket.id, formatTicketKey(key, ticket.number));
		return tx.update(projects).set({ key }).where(eq(projects.id, projectId)).returning().get();
	});
}

export function setInitialState(db: Db, projectId: number, stateId: number) {
	return db.transaction((tx) => {
		getProject(tx, projectId);
		const state = getState(tx, stateId);
		if (state.projectId !== projectId) {
			throw new DomainError('invalid', 'The Initial State must belong to the Project');
		}
		if (state.isClosed) throw new DomainError('invalid', 'The Initial State cannot be Closed');
		return tx
			.update(projects)
			.set({ initialStateId: stateId })
			.where(eq(projects.id, projectId))
			.returning()
			.get();
	});
}

export function deleteProject(db: Db, projectId: number): void {
	db.transaction((tx) => {
		getProject(tx, projectId);
		tx.delete(projects).where(eq(projects.id, projectId)).run();
	});
}

function assertKeyAvailable(db: Handle, key: string, selfId: number | null): void {
	const holder = db.select().from(projectKeys).where(eq(projectKeys.key, key)).get();
	if (holder && holder.projectId !== selfId) {
		throw new DomainError('conflict', `Project key ${key} is already in use`);
	}
}
