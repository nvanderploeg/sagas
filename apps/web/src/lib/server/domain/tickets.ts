import { asc, eq, inArray } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { projectKeys, projects, ticketKeys, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { formatTicketKey, parseTicketKey } from './keys.ts';
import { getProject, getState, getSubstate, getTicket, requireUser } from './lookup.ts';
import { listSubstates } from './states.ts';
import { requireText } from './validate.ts';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 50_000;

export type TicketSpec = {
	projectId: number;
	title: string;
	description?: string;
	ownerId: number;
	assigneeId?: number | null;
	stateId?: number;
	substateId?: number | null;
	parentId?: number | null;
};

export type TicketPatch = {
	title?: string;
	description?: string;
	ownerId?: number;
	assigneeId?: number | null;
	stateId?: number;
	substateId?: number | null;
	parentId?: number | null;
};

export function ticketKeyOf(db: Handle, ticket: { projectId: number; number: number }): string {
	return formatTicketKey(getProject(db, ticket.projectId).key, ticket.number);
}

export function listTickets(db: Handle, projectId: number) {
	return db
		.select()
		.from(tickets)
		.where(eq(tickets.projectId, projectId))
		.orderBy(asc(tickets.number))
		.all();
}

export function resolveTicketKey(db: Handle, input: string) {
	const parsed = parseTicketKey(input);
	if (!parsed) return null;
	const row = db
		.select({ ticket: tickets })
		.from(ticketKeys)
		.innerJoin(tickets, eq(tickets.id, ticketKeys.ticketId))
		.where(eq(ticketKeys.key, formatTicketKey(parsed.projectKey, parsed.number)))
		.get();
	return row?.ticket ?? null;
}

// Record every key a Ticket comes to hold, so that key resolves to it for as long as it exists.
export function recordTicketKey(db: Handle, ticketId: number, key: string): void {
	const holder = db.select().from(ticketKeys).where(eq(ticketKeys.key, key)).get();
	if (holder?.ticketId === ticketId) return;
	if (holder) throw new DomainError('conflict', `Ticket key ${key} is already taken`);
	db.insert(ticketKeys).values({ key, ticketId }).run();
}

export function createTicket(db: Db, input: TicketSpec) {
	return db.transaction((tx) => {
		const project = getProject(tx, input.projectId);
		const title = requireText(input.title, 'Ticket title', TITLE_MAX);
		const description = checkDescription(input.description ?? '');
		const ownerId = requireUser(tx, input.ownerId, 'Owner');
		const assigneeId =
			input.assigneeId == null ? null : requireUser(tx, input.assigneeId, 'Assignee');

		const stateId = input.stateId ?? project.initialStateId;
		if (stateId === null) throw new DomainError('conflict', 'The Project has no Initial State');
		const state = getState(tx, stateId);
		if (state.projectId !== project.id) {
			throw new DomainError('invalid', 'The State belongs to another Project');
		}
		const substateId = substateFor(tx, state, input.substateId);
		const parentId = input.parentId ?? null;
		if (parentId !== null) assertParent(tx, null, parentId);

		const number = allocateNumber(tx, project.id);
		const ticket = tx
			.insert(tickets)
			.values({
				projectId: project.id,
				number,
				title,
				description,
				ownerId,
				assigneeId,
				stateId: state.id,
				substateId,
				parentId
			})
			.returning()
			.get();
		recordTicketKey(tx, ticket.id, formatTicketKey(project.key, number));
		return ticket;
	});
}

export function updateTicket(db: Db, ticketId: number, patch: TicketPatch) {
	return db.transaction((tx) => {
		const ticket = getTicket(tx, ticketId);
		const changes: Partial<typeof tickets.$inferInsert> = {};

		if (patch.title !== undefined) {
			changes.title = requireText(patch.title, 'Ticket title', TITLE_MAX);
		}
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) changes.ownerId = requireUser(tx, patch.ownerId, 'Owner');
		if (patch.assigneeId !== undefined) {
			changes.assigneeId =
				patch.assigneeId === null ? null : requireUser(tx, patch.assigneeId, 'Assignee');
		}

		const moving = patch.stateId !== undefined && patch.stateId !== ticket.stateId;
		if (patch.stateId !== undefined) {
			const state = getState(tx, patch.stateId);
			if (state.projectId !== ticket.projectId) {
				throw new DomainError('invalid', 'The State belongs to another Project');
			}
			changes.stateId = state.id;
			if (moving || patch.substateId !== undefined) {
				changes.substateId = substateFor(tx, state, patch.substateId);
			}
		} else if (patch.substateId !== undefined) {
			changes.substateId = substateFor(tx, getState(tx, ticket.stateId), patch.substateId);
		}

		if (patch.parentId !== undefined && patch.parentId !== null) {
			assertParent(tx, ticketId, patch.parentId);
		}
		if (patch.parentId !== undefined) changes.parentId = patch.parentId;

		if (Object.keys(changes).length === 0) return ticket;
		changes.updatedAt = new Date();
		return tx.update(tickets).set(changes).where(eq(tickets.id, ticketId)).returning().get();
	});
}

export function moveTicket(db: Db, ticketId: number, projectId: number) {
	return db.transaction((tx) => {
		const ticket = getTicket(tx, ticketId);
		if (ticket.projectId === projectId) {
			throw new DomainError('invalid', 'The Ticket is already in that Project');
		}
		const target = getProject(tx, projectId);
		if (target.initialStateId === null) {
			throw new DomainError('conflict', 'The target Project has no Initial State');
		}
		const state = getState(tx, target.initialStateId);
		const substateId = substateFor(tx, state, undefined);

		const number = allocateNumber(tx, target.id);
		recordTicketKey(tx, ticketId, formatTicketKey(target.key, number));
		return tx
			.update(tickets)
			.set({
				projectId: target.id,
				number,
				stateId: state.id,
				substateId,
				updatedAt: new Date()
			})
			.where(eq(tickets.id, ticketId))
			.returning()
			.get();
	});
}

export function deleteTicket(db: Db, ticketId: number): void {
	db.transaction((tx) => {
		getTicket(tx, ticketId);
		tx.delete(tickets).where(eq(tickets.id, ticketId)).run();
	});
}

function checkDescription(value: string): string {
	if (value.length > DESCRIPTION_MAX) {
		throw new DomainError(
			'invalid',
			`Ticket description must be at most ${DESCRIPTION_MAX} characters`
		);
	}
	return value;
}

// Substate placement follows the Substate rule in CONTEXT.md.
function substateFor(
	db: Handle,
	state: { id: number; defaultSubstateId: number | null },
	requested: number | null | undefined
): number | null {
	if (listSubstates(db, state.id).length === 0) {
		if (typeof requested === 'number') {
			throw new DomainError('invalid', 'The State has no Substates');
		}
		return null;
	}
	if (requested == null) {
		if (state.defaultSubstateId === null) {
			throw new DomainError('conflict', 'The State has no default Substate');
		}
		return state.defaultSubstateId;
	}
	const substate = getSubstate(db, requested);
	if (substate.stateId !== state.id) {
		throw new DomainError('invalid', 'The Substate belongs to another State');
	}
	return substate.id;
}

// Skip every number whose key under any of the Project's keys, current or former, is held: a
// Project must always be able to take back a former key.
function allocateNumber(db: Handle, projectId: number): number {
	const keys = db
		.select({ key: projectKeys.key })
		.from(projectKeys)
		.where(eq(projectKeys.projectId, projectId))
		.all()
		.map((row) => row.key);
	const held = (number: number) =>
		db
			.select()
			.from(ticketKeys)
			.where(
				inArray(
					ticketKeys.key,
					keys.map((key) => formatTicketKey(key, number))
				)
			)
			.get() !== undefined;

	let number = getProject(db, projectId).ticketCounter + 1;
	while (held(number)) number += 1;
	db.update(projects).set({ ticketCounter: number }).where(eq(projects.id, projectId)).run();
	return number;
}

function assertParent(db: Handle, ticketId: number | null, parentId: number): void {
	if (parentId === ticketId) throw new DomainError('invalid', 'A Ticket cannot be its own Parent');
	let cursor: number | null = parentId;
	const seen = new Set<number>();
	while (cursor !== null) {
		const row = getTicket(db, cursor);
		if (cursor === ticketId) throw new DomainError('conflict', 'The Parent would create a cycle');
		if (seen.has(cursor)) throw new Error(`Parent chain loops at Ticket ${cursor}`);
		seen.add(cursor);
		cursor = row.parentId;
	}
}
