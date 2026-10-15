import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { projectKeys, projects, states, ticketKeys, tickets } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { falloutEvents, prepareTicketDelete } from './cascade.ts';
import { DomainError } from './errors.ts';
import { formatTicketKey, parseTicketKey } from './keys.ts';
import { getProject, getState, getSubstate, getTicket, requireUser } from './lookup.ts';
import { rankAt, type Placement } from './rank.ts';
import { listSubstates } from './states.ts';
import {
	readTicket,
	selectTicketViews,
	ticketName,
	toTicketView,
	type Ticket,
	type TicketView
} from './ticket-view.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export {
	readTicket,
	selectTicketViews,
	toTicketView,
	type Ticket,
	type TicketView
} from './ticket-view.ts';

const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 50_000;

export type TicketSpec = {
	projectId: number;
	title: string;
	description?: string;
	ownerId: number;
	assigneeId?: number | null;
	stateId?: number;
	substateId?: number | null;
	parentId?: number | null;
	placement?: Placement;
};

// A placement applies in the State the Ticket ends up in; a new State without one means bottom.
export type TicketPatch = {
	title?: string;
	description?: string;
	ownerId?: number;
	assigneeId?: number | null;
	stateId?: number;
	substateId?: number | null;
	placement?: Placement;
};

export function ticketKeyOf(db: Handle, ticket: { projectId: number; number: number }): string {
	return formatTicketKey(getProject(db, ticket.projectId).key, ticket.number);
}

export function listTickets(db: Handle, projectId: number): TicketView[] {
	return selectTicketViews(db)
		.where(eq(tickets.projectId, projectId))
		.orderBy(asc(tickets.number))
		.all()
		.map(toTicketView);
}

export function listColumn(db: Handle, stateId: number): TicketView[] {
	return selectTicketViews(db)
		.where(eq(tickets.stateId, stateId))
		.orderBy(asc(tickets.rank))
		.all()
		.map(toTicketView);
}

function columnOf(db: Handle, stateId: number) {
	return db
		.select({ id: tickets.id, rank: tickets.rank })
		.from(tickets)
		.where(eq(tickets.stateId, stateId))
		.orderBy(asc(tickets.rank))
		.all();
}

export function listChildren(db: Handle, ticketId: number): TicketView[] {
	return selectTicketViews(db)
		.where(eq(tickets.parentId, ticketId))
		.orderBy(asc(tickets.id))
		.all()
		.map(toTicketView);
}

export function resolveTicketKey(db: Handle, input: string): TicketView | null {
	const parsed = parseTicketKey(input);
	if (!parsed) return null;
	const row = db
		.select({ ticketId: ticketKeys.ticketId })
		.from(ticketKeys)
		.where(eq(ticketKeys.key, formatTicketKey(parsed.projectKey, parsed.number)))
		.get();
	return row ? readTicket(db, row.ticketId) : null;
}

// Record every key a Ticket comes to hold, so that key resolves to it for as long as it exists.
export function recordTicketKey(db: Handle, ticketId: number, key: string): void {
	const holder = db.select().from(ticketKeys).where(eq(ticketKeys.key, key)).get();
	if (holder?.ticketId === ticketId) return;
	if (holder) throw new DomainError('conflict', `Ticket key ${key} is already taken`);
	db.insert(ticketKeys).values({ key, ticketId }).run();
}

function ticketOutcome(
	db: Handle,
	type: 'ticket.created' | 'ticket.updated' | 'ticket.moved' | 'ticket.reparented',
	ticketId: number
): { value: TicketView; events: EventSpec[] } {
	const ticket = readTicket(db, ticketId);
	return { value: ticket, events: [{ type, data: { ticket } }] };
}

export function createTicket(db: Db, actor: Actor, input: TicketSpec): TicketView {
	return write(db, actor, (tx) => {
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

		const rank = rankAt(
			columnOf(tx, state.id),
			{ id: null },
			input.placement ?? 'bottom',
			'State',
			ticketName(tx)
		);
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
				parentId,
				rank
			})
			.returning()
			.get();
		recordTicketKey(tx, ticket.id, formatTicketKey(project.key, number));
		return ticketOutcome(tx, 'ticket.created', ticket.id);
	});
}

export function updateTicket(
	db: Db,
	actor: Actor,
	ticketId: number,
	patch: TicketPatch
): TicketView {
	return write(db, actor, (tx) => {
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
		if (moving || patch.placement !== undefined) {
			const stateId = changes.stateId ?? ticket.stateId;
			changes.rank = rankAt(
				columnOf(tx, stateId),
				{ id: ticketId, rank: moving ? undefined : ticket.rank },
				patch.placement ?? 'bottom',
				'State',
				ticketName(tx)
			);
		}

		const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
			(key) => changes[key] !== ticket[key as keyof Ticket]
		);
		if (changed.length === 0) return { value: readTicket(tx, ticketId), events: [] };
		if (changed.length === 1 && changed[0] === 'rank') {
			const rank = changes.rank!;
			tx.update(tickets).set({ rank }).where(eq(tickets.id, ticketId)).run();
			return {
				value: readTicket(tx, ticketId),
				events: [{ type: 'ticket.ranked', data: { id: ticketId, stateId: ticket.stateId, rank } }]
			};
		}
		changes.updatedAt = new Date();
		tx.update(tickets).set(changes).where(eq(tickets.id, ticketId)).run();
		return ticketOutcome(tx, 'ticket.updated', ticketId);
	});
}

export function setParent(
	db: Db,
	actor: Actor,
	ticketId: number,
	parentId: number | null
): TicketView {
	return write(db, actor, (tx) => {
		const ticket = getTicket(tx, ticketId);
		if (parentId !== null) assertParent(tx, ticketId, parentId);
		if (parentId === ticket.parentId) return { value: readTicket(tx, ticketId), events: [] };
		tx.update(tickets)
			.set({ parentId, updatedAt: new Date() })
			.where(eq(tickets.id, ticketId))
			.run();
		return ticketOutcome(tx, 'ticket.reparented', ticketId);
	});
}

export type MoveTarget = {
	projectId: number;
	stateId?: number;
	substateId?: number | null;
	placement?: Placement;
};

// Moving follows the Moving a Ticket decision in docs/mvp.md.
export function moveTicket(db: Db, actor: Actor, ticketId: number, input: MoveTarget): TicketView {
	return write(db, actor, (tx) => {
		const ticket = getTicket(tx, ticketId);
		if (ticket.projectId === input.projectId) {
			throw new DomainError('invalid', 'The Ticket is already in that Project');
		}
		const target = getProject(tx, input.projectId);
		const state = targetState(tx, target, getState(tx, ticket.stateId).isClosed, input.stateId);
		const substateId = substateFor(tx, state, input.substateId);
		const rank = rankAt(
			columnOf(tx, state.id),
			{ id: ticketId },
			input.placement ?? 'bottom',
			'State',
			ticketName(tx)
		);

		const number = allocateNumber(tx, target.id);
		recordTicketKey(tx, ticketId, formatTicketKey(target.key, number));
		tx.update(tickets)
			.set({
				projectId: target.id,
				number,
				stateId: state.id,
				substateId,
				rank,
				updatedAt: new Date()
			})
			.where(eq(tickets.id, ticketId))
			.run();
		return ticketOutcome(tx, 'ticket.moved', ticketId);
	});
}

// Rank follows the Rank decision in docs/mvp.md: write only this Ticket's row.
export function rankTicket(
	db: Db,
	actor: Actor,
	ticketId: number,
	placement: Placement
): TicketView {
	return write(db, actor, (tx) => {
		const ticket = getTicket(tx, ticketId);
		const rank = rankAt(columnOf(tx, ticket.stateId), ticket, placement, 'State', ticketName(tx));
		if (rank === ticket.rank) return { value: readTicket(tx, ticketId), events: [] };
		tx.update(tickets).set({ rank }).where(eq(tickets.id, ticketId)).run();
		return {
			value: readTicket(tx, ticketId),
			events: [{ type: 'ticket.ranked', data: { id: ticketId, stateId: ticket.stateId, rank } }]
		};
	});
}

export function deleteTicket(db: Db, actor: Actor, ticketId: number): void {
	write(db, actor, (tx) => {
		const ticket = getTicket(tx, ticketId);
		const fallout = prepareTicketDelete(tx, eq(tickets.id, ticketId));
		tx.delete(tickets).where(eq(tickets.id, ticketId)).run();
		return {
			value: undefined,
			events: [
				{ type: 'ticket.deleted', data: { id: ticketId, projectId: ticket.projectId } },
				...falloutEvents(tx, fallout)
			]
		};
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

function targetState(
	db: Handle,
	target: { id: number; initialStateId: number | null },
	closed: boolean,
	requested: number | undefined
) {
	if (closed) {
		const state = db
			.select()
			.from(states)
			.where(and(eq(states.projectId, target.id), eq(states.isClosed, true)))
			.get();
		if (state === undefined) {
			throw new DomainError('conflict', 'The target Project has no Closed State');
		}
		if (requested !== undefined && requested !== state.id) {
			throw new DomainError(
				'invalid',
				"A Closed Ticket moves into the target Project's Closed State"
			);
		}
		return state;
	}
	const stateId = requested ?? target.initialStateId;
	if (stateId === null) {
		throw new DomainError('conflict', 'The target Project has no Initial State');
	}
	const state = getState(db, stateId);
	if (state.projectId !== target.id) {
		throw new DomainError('invalid', 'The State belongs to another Project');
	}
	return state;
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
