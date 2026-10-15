import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { states, substates, tickets } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { getProject, getState, getSubstate } from './lookup.ts';
import type { EventSpec } from '../events/types.ts';
import { placeAt, writePositions } from './positions.ts';
import { stateEvent, substateEvent } from './project-view.ts';
import { readTicket } from './ticket-view.ts';
import { COLOR, ICON, requireMatch, requireText, STATE_KEY } from './validate.ts';
import { write, type Actor } from './write.ts';

export type State = typeof states.$inferSelect;
export type Substate = typeof substates.$inferSelect;

export type StyleSpec = { key: string; label: string; color: string; icon: string };
export type StyleUpdate = Partial<Pick<StyleSpec, 'label' | 'color' | 'icon'>>;

export const CLOSED_STATE: StyleSpec = {
	key: 'closed',
	label: 'Closed',
	color: '#6b7280',
	icon: 'check'
};

function normalizeStyle(spec: StyleSpec, kind: 'State' | 'Substate'): StyleSpec {
	return {
		key: requireMatch(
			spec.key,
			STATE_KEY,
			`${kind} key must be lowercase letters, digits and hyphens, starting with a letter`
		),
		label: requireText(spec.label, `${kind} label`, 64),
		color: requireMatch(spec.color, COLOR, `${kind} color must be a #rrggbb value`),
		icon: requireMatch(spec.icon, ICON, `${kind} icon must be a lowercase icon name`)
	};
}

function normalizeUpdate(patch: StyleUpdate, kind: 'State' | 'Substate'): StyleUpdate {
	const update: StyleUpdate = {};
	if (patch.label !== undefined) update.label = requireText(patch.label, `${kind} label`, 64);
	if (patch.color !== undefined) {
		update.color = requireMatch(patch.color, COLOR, `${kind} color must be a #rrggbb value`);
	}
	if (patch.icon !== undefined) {
		update.icon = requireMatch(patch.icon, ICON, `${kind} icon must be a lowercase icon name`);
	}
	return update;
}

export function listStates(db: Handle, projectId: number) {
	return db
		.select()
		.from(states)
		.where(eq(states.projectId, projectId))
		.orderBy(asc(states.position))
		.all();
}

export function listSubstates(db: Handle, stateId: number) {
	return db
		.select()
		.from(substates)
		.where(eq(substates.stateId, stateId))
		.orderBy(asc(substates.position))
		.all();
}

// Closed keeps the last slot: a new open State is placed among the open States only.
export function insertState(
	db: Handle,
	projectId: number,
	input: StyleSpec,
	options: { index?: number; closed?: boolean } = {}
) {
	const spec = normalizeStyle(input, 'State');
	const closed = options.closed ?? false;
	if (!closed && spec.key === CLOSED_STATE.key) {
		throw new DomainError('conflict', '"closed" is the built-in Closed State');
	}
	const existing = listStates(db, projectId);
	if (existing.some((s) => s.key === spec.key)) {
		throw new DomainError('conflict', `State key "${spec.key}" is already used in this Project`);
	}

	const row = db
		.insert(states)
		.values({ projectId, ...spec, position: existing.length, isClosed: closed })
		.returning()
		.get();

	const open = existing.filter((s) => !s.isClosed).map((s) => s.id);
	const shut = existing.filter((s) => s.isClosed).map((s) => s.id);
	const order = closed
		? [...open, ...shut, row.id]
		: [...placeAt(open, row.id, options.index), ...shut];
	writePositions(order, (id, position) =>
		db.update(states).set({ position }).where(eq(states.id, id)).run()
	);
	return getState(db, row.id);
}

export function createState(
	db: Db,
	actor: Actor,
	projectId: number,
	input: StyleSpec,
	index?: number
): State {
	return write(db, actor, (tx) => {
		getProject(tx, projectId);
		const value = insertState(tx, projectId, input, { index });
		return {
			value,
			events: [stateEvent(tx, 'state.created', projectId, value.id)]
		};
	});
}

export function updateState(db: Db, actor: Actor, stateId: number, patch: StyleUpdate): State {
	return write(db, actor, (tx) => {
		const state = getState(tx, stateId);
		const update = normalizeUpdate(patch, 'State');
		if (state.isClosed && update.label !== undefined && update.label !== state.label) {
			throw new DomainError('forbidden', 'The Closed State cannot be renamed');
		}
		if (!changes(state, update)) return { value: state, events: [] };
		const value = tx.update(states).set(update).where(eq(states.id, stateId)).returning().get();
		return { value, events: [stateEvent(tx, 'state.updated', state.projectId, stateId)] };
	});
}

export function moveState(db: Db, actor: Actor, stateId: number, index: number): State {
	return write(db, actor, (tx) => {
		const state = getState(tx, stateId);
		if (state.isClosed) throw new DomainError('forbidden', 'The Closed State cannot be reordered');
		const rows = listStates(tx, state.projectId);
		const open = rows.filter((s) => !s.isClosed && s.id !== stateId).map((s) => s.id);
		const shut = rows.filter((s) => s.isClosed).map((s) => s.id);
		const order = [...placeAt(open, stateId, index), ...shut];
		if (order.every((id, i) => rows[i].id === id)) return { value: state, events: [] };
		writePositions(order, (id, position) =>
			tx.update(states).set({ position }).where(eq(states.id, id)).run()
		);
		return {
			value: getState(tx, stateId),
			events: [stateEvent(tx, 'state.updated', state.projectId, stateId)]
		};
	});
}

export function deleteState(db: Db, actor: Actor, stateId: number): void {
	write(db, actor, (tx) => {
		const state = getState(tx, stateId);
		if (state.isClosed) throw new DomainError('forbidden', 'The Closed State cannot be removed');
		const project = getProject(tx, state.projectId);
		if (project.initialStateId === stateId) {
			throw new DomainError('conflict', 'Pick another Initial State before removing this one');
		}
		const held = tx
			.select({ id: tickets.id })
			.from(tickets)
			.where(eq(tickets.stateId, stateId))
			.get();
		if (held) throw new DomainError('conflict', 'The State still holds Tickets');

		tx.delete(states).where(eq(states.id, stateId)).run();
		writePositions(
			listStates(tx, state.projectId).map((s) => s.id),
			(id, position) => tx.update(states).set({ position }).where(eq(states.id, id)).run()
		);
		return {
			value: undefined,
			events: [stateEvent(tx, 'state.deleted', state.projectId, stateId)]
		};
	});
}

export function createSubstate(
	db: Db,
	actor: Actor,
	stateId: number,
	input: StyleSpec,
	index?: number
): Substate {
	return write(db, actor, (tx) => {
		getState(tx, stateId);
		const spec = normalizeStyle(input, 'Substate');
		const existing = listSubstates(tx, stateId);
		if (existing.some((s) => s.key === spec.key)) {
			throw new DomainError('conflict', `Substate key "${spec.key}" is already used in this State`);
		}

		const row = tx
			.insert(substates)
			.values({ stateId, ...spec, position: existing.length })
			.returning()
			.get();
		writePositions(
			placeAt(
				existing.map((s) => s.id),
				row.id,
				index
			),
			(id, position) => tx.update(substates).set({ position }).where(eq(substates.id, id)).run()
		);

		// Follows the Substate rule in CONTEXT.md.
		const moved: number[] = [];
		if (existing.length === 0) {
			tx.update(states).set({ defaultSubstateId: row.id }).where(eq(states.id, stateId)).run();
			const unplaced = and(eq(tickets.stateId, stateId), isNull(tickets.substateId));
			for (const ticket of tx.select({ id: tickets.id }).from(tickets).where(unplaced).all()) {
				moved.push(ticket.id);
			}
			tx.update(tickets).set({ substateId: row.id, updatedAt: new Date() }).where(unplaced).run();
		}
		return {
			value: getSubstate(tx, row.id),
			events: [
				substateEvent(tx, 'substate.created', row),
				...moved.map((id): EventSpec => ({
					type: 'ticket.updated',
					data: { ticket: readTicket(tx, id) }
				}))
			]
		};
	});
}

export function updateSubstate(
	db: Db,
	actor: Actor,
	substateId: number,
	patch: StyleUpdate
): Substate {
	return write(db, actor, (tx) => {
		const substate = getSubstate(tx, substateId);
		const update = normalizeUpdate(patch, 'Substate');
		if (!changes(substate, update)) return { value: substate, events: [] };
		const value = tx
			.update(substates)
			.set(update)
			.where(eq(substates.id, substateId))
			.returning()
			.get();
		return { value, events: [substateEvent(tx, 'substate.updated', substate)] };
	});
}

export function moveSubstate(db: Db, actor: Actor, substateId: number, index: number): Substate {
	return write(db, actor, (tx) => {
		const substate = getSubstate(tx, substateId);
		const rows = listSubstates(tx, substate.stateId).map((s) => s.id);
		const order = placeAt(
			rows.filter((id) => id !== substateId),
			substateId,
			index
		);
		if (order.every((id, i) => rows[i] === id)) return { value: substate, events: [] };
		writePositions(order, (id, position) =>
			tx.update(substates).set({ position }).where(eq(substates.id, id)).run()
		);
		return {
			value: getSubstate(tx, substateId),
			events: [substateEvent(tx, 'substate.updated', substate)]
		};
	});
}

export function deleteSubstate(db: Db, actor: Actor, substateId: number): void {
	write(db, actor, (tx) => {
		const substate = getSubstate(tx, substateId);
		const state = getState(tx, substate.stateId);
		if (state.defaultSubstateId === substateId && listSubstates(tx, state.id).length > 1) {
			throw new DomainError('conflict', 'Set another default Substate before removing this one');
		}
		const held = tx
			.select({ id: tickets.id })
			.from(tickets)
			.where(eq(tickets.substateId, substateId))
			.get();
		if (held) throw new DomainError('conflict', 'The Substate still holds Tickets');

		tx.delete(substates).where(eq(substates.id, substateId)).run();
		writePositions(
			listSubstates(tx, state.id).map((s) => s.id),
			(id, position) => tx.update(substates).set({ position }).where(eq(substates.id, id)).run()
		);
		return { value: undefined, events: [substateEvent(tx, 'substate.deleted', substate)] };
	});
}

export function setDefaultSubstate(
	db: Db,
	actor: Actor,
	stateId: number,
	substateId: number
): State {
	return write(db, actor, (tx) => {
		const state = getState(tx, stateId);
		const substate = getSubstate(tx, substateId);
		if (substate.stateId !== state.id) {
			throw new DomainError('invalid', 'The default Substate must belong to the State');
		}
		if (state.defaultSubstateId === substateId) return { value: state, events: [] };
		const value = tx
			.update(states)
			.set({ defaultSubstateId: substateId })
			.where(eq(states.id, stateId))
			.returning()
			.get();
		return { value, events: [stateEvent(tx, 'state.updated', state.projectId, stateId)] };
	});
}

function changes(row: StyleUpdate, update: StyleUpdate): boolean {
	return (Object.keys(update) as (keyof StyleUpdate)[]).some((key) => update[key] !== row[key]);
}
