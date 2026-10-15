import { and, asc, eq, like } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { projectKeyAliases, projects, ticketKeyAliases, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { getProject, getState } from './lookup.ts';
import { CLOSED_STATE, insertState, type StyleSpec } from './states.ts';
import { normalizeProjectKey } from './keys.ts';
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

		tx.insert(projectKeyAliases)
			.values({ key: project.key, projectId })
			.onConflictDoNothing()
			.run();
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

// Retired keys stay reserved: a new key must clear both project_key_aliases and ticket_key_aliases.
function assertKeyAvailable(db: Handle, key: string, selfId: number | null): void {
	const owner = db.select({ id: projects.id }).from(projects).where(eq(projects.key, key)).get();
	if (owner && owner.id !== selfId) {
		throw new DomainError('conflict', `Project key ${key} is already in use`);
	}

	const retired = db.select().from(projectKeyAliases).where(eq(projectKeyAliases.key, key)).get();
	if (retired && retired.projectId !== selfId) {
		throw new DomainError('conflict', `Project key ${key} belongs to a Project's alias`);
	}

	const aliased = db
		.select({
			alias: ticketKeyAliases.key,
			ticketId: ticketKeyAliases.ticketId,
			projectId: tickets.projectId
		})
		.from(ticketKeyAliases)
		.innerJoin(tickets, eq(tickets.id, ticketKeyAliases.ticketId))
		.where(like(ticketKeyAliases.key, `${key}-%`))
		.all();
	for (const row of aliased) {
		if (row.projectId !== selfId) {
			throw new DomainError(
				'conflict',
				`Ticket key ${row.alias} is an alias of another Project's Ticket`
			);
		}
		const number = Number(row.alias.slice(key.length + 1));
		const clash = db
			.select({ id: tickets.id })
			.from(tickets)
			.where(and(eq(tickets.projectId, row.projectId), eq(tickets.number, number)))
			.get();
		if (clash && clash.id !== row.ticketId) {
			throw new DomainError('conflict', `Ticket key ${row.alias} is already taken`);
		}
	}
}
