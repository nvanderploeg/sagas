import { mapSeq } from '#lib/server/async.ts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { states, stateFlows, substates, labours } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { getRealm, getState, getSubstate } from './lookup.ts';
import type { EventSpec } from '../events/types.ts';
import { placeAt, writePositions } from './positions.ts';
import { stateEvent, substateEvent } from './realm-view.ts';
import { readLabour } from './labour-view.ts';
import { COLOR, ICON, requireMatch, requireText, STATE_KEY } from './validate.ts';
import { requireRealmRole } from './access.ts';
import { write, type Actor } from './write.ts';

export type State = typeof states.$inferSelect;
export type Substate = typeof substates.$inferSelect;

export type StyleSpec = { key: string; label: string; color: string; icon: string };
export type StyleUpdate = Partial<Pick<StyleSpec, 'label' | 'color' | 'icon'>>;
export type StateUpdate = StyleUpdate & { open?: boolean };

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

export async function listStates(db: Handle, realmId: number) {
	return await db
		.select()
		.from(states)
		.where(eq(states.realmId, realmId))
		.orderBy(asc(states.position));
}

export async function listSubstates(db: Handle, stateId: number) {
	return await db
		.select()
		.from(substates)
		.where(eq(substates.stateId, stateId))
		.orderBy(asc(substates.position));
}

// Closed keeps the last slot: a new State is placed among the States before it.
export async function insertState(
	db: Handle,
	realmId: number,
	input: StyleSpec,
	options: { index?: number; closed?: boolean; open?: boolean } = {}
) {
	const spec = normalizeStyle(input, 'State');
	const closed = options.closed ?? false;
	if (!closed && spec.key === CLOSED_STATE.key) {
		throw new DomainError('conflict', '"closed" is the built-in Closed State');
	}
	const existing = await listStates(db, realmId);
	if (existing.some((s) => s.key === spec.key)) {
		throw new DomainError('conflict', `State key "${spec.key}" is already used in this Realm`);
	}

	const row = (
		await db
			.insert(states)
			.values({
				realmId,
				...spec,
				position: existing.length,
				isClosed: closed,
				isOpen: !closed && (options.open ?? true)
			})
			.returning()
	)[0];

	const open = existing.filter((s) => !s.isClosed).map((s) => s.id);
	const shut = existing.filter((s) => s.isClosed).map((s) => s.id);
	const order = closed
		? [...open, ...shut, row.id]
		: [...placeAt(open, row.id, options.index), ...shut];
	await writePositions(
		order,
		async (id, position) => await db.update(states).set({ position }).where(eq(states.id, id))
	);
	return getState(db, row.id);
}

export async function createState(
	db: Db,
	actor: Actor,
	realmId: number,
	input: StyleSpec,
	index?: number,
	open?: boolean
): Promise<State> {
	return write(db, actor, async (tx) => {
		await getRealm(tx, realmId);
		await requireRealmRole(tx, actor, realmId, 'owner');
		const value = await insertState(tx, realmId, input, { index, open });
		return {
			value,
			events: [await stateEvent(tx, 'state.created', realmId, value.id)]
		};
	});
}

export async function updateState(
	db: Db,
	actor: Actor,
	stateId: number,
	patch: StateUpdate
): Promise<State> {
	return write(db, actor, async (tx) => {
		const state = await getState(tx, stateId);
		await requireRealmRole(tx, actor, state.realmId, 'owner');
		const update: Partial<Pick<State, 'label' | 'color' | 'icon' | 'isOpen'>> = normalizeUpdate(
			patch,
			'State'
		);
		if (state.isClosed && update.label !== undefined && update.label !== state.label) {
			throw new DomainError('forbidden', 'The Closed State cannot be renamed');
		}
		if (patch.open !== undefined) {
			if (state.isClosed && patch.open) {
				throw new DomainError('forbidden', 'The Closed State cannot be open');
			}
			update.isOpen = patch.open;
		}
		if (!changes(state, update)) return { value: state, events: [] };
		const value = (
			await tx.update(states).set(update).where(eq(states.id, stateId)).returning()
		)[0];
		return { value, events: [await stateEvent(tx, 'state.updated', state.realmId, stateId)] };
	});
}

// Replaces the States a Labour in this State usually moves to next. Moves stay unrestricted.
export async function setNextStates(
	db: Db,
	actor: Actor,
	stateId: number,
	next: number[]
): Promise<State> {
	return write(db, actor, async (tx) => {
		const state = await getState(tx, stateId);
		await requireRealmRole(tx, actor, state.realmId, 'owner');
		if (state.isClosed) throw new DomainError('forbidden', 'The Closed State has no next States');
		const ids = [...new Set(next)];
		const realmStates = await listStates(tx, state.realmId);
		for (const id of ids) {
			if (id === stateId) throw new DomainError('invalid', 'A State cannot flow into itself');
			if (!realmStates.some((s) => s.id === id)) {
				throw new DomainError('invalid', 'A next State must belong to the same Realm');
			}
		}
		const current = (
			await tx
				.select({ id: stateFlows.toStateId })
				.from(stateFlows)
				.where(eq(stateFlows.fromStateId, stateId))
		).map((r) => r.id);
		if (current.length === ids.length && ids.every((id) => current.includes(id))) {
			return { value: state, events: [] };
		}
		await tx.delete(stateFlows).where(eq(stateFlows.fromStateId, stateId));
		if (ids.length > 0) {
			await tx
				.insert(stateFlows)
				.values(ids.map((toStateId) => ({ fromStateId: stateId, toStateId })));
		}
		return {
			value: state,
			events: [await stateEvent(tx, 'state.updated', state.realmId, stateId)]
		};
	});
}

export async function moveState(
	db: Db,
	actor: Actor,
	stateId: number,
	index: number
): Promise<State> {
	return write(db, actor, async (tx) => {
		const state = await getState(tx, stateId);
		await requireRealmRole(tx, actor, state.realmId, 'owner');
		if (state.isClosed) throw new DomainError('forbidden', 'The Closed State cannot be reordered');
		const rows = await listStates(tx, state.realmId);
		const open = rows.filter((s) => !s.isClosed && s.id !== stateId).map((s) => s.id);
		const shut = rows.filter((s) => s.isClosed).map((s) => s.id);
		const order = [...placeAt(open, stateId, index), ...shut];
		if (order.every((id, i) => rows[i].id === id)) return { value: state, events: [] };
		await writePositions(
			order,
			async (id, position) => await tx.update(states).set({ position }).where(eq(states.id, id))
		);
		return {
			value: await getState(tx, stateId),
			events: [await stateEvent(tx, 'state.updated', state.realmId, stateId)]
		};
	});
}

export async function deleteState(db: Db, actor: Actor, stateId: number): Promise<void> {
	await write(db, actor, async (tx) => {
		const state = await getState(tx, stateId);
		await requireRealmRole(tx, actor, state.realmId, 'owner');
		if (state.isClosed) throw new DomainError('forbidden', 'The Closed State cannot be removed');
		const realm = await getRealm(tx, state.realmId);
		if (realm.initialStateId === stateId) {
			throw new DomainError('conflict', 'Pick another Initial State before removing this one');
		}
		const held = (
			await tx.select({ id: labours.id }).from(labours).where(eq(labours.stateId, stateId)).limit(1)
		)[0];
		if (held) throw new DomainError('conflict', 'The State still holds Labours');

		await tx.delete(states).where(eq(states.id, stateId));
		await writePositions(
			(await listStates(tx, state.realmId)).map((s) => s.id),
			async (id, position) => await tx.update(states).set({ position }).where(eq(states.id, id))
		);
		return {
			value: undefined,
			events: [await stateEvent(tx, 'state.deleted', state.realmId, stateId)]
		};
	});
}

export async function createSubstate(
	db: Db,
	actor: Actor,
	stateId: number,
	input: StyleSpec,
	index?: number
): Promise<Substate> {
	return write(db, actor, async (tx) => {
		await requireRealmRole(tx, actor, (await getState(tx, stateId)).realmId, 'owner');
		const spec = normalizeStyle(input, 'Substate');
		const existing = await listSubstates(tx, stateId);
		if (existing.some((s) => s.key === spec.key)) {
			throw new DomainError('conflict', `Substate key "${spec.key}" is already used in this State`);
		}

		const row = (
			await tx
				.insert(substates)
				.values({ stateId, ...spec, position: existing.length })
				.returning()
		)[0];
		await writePositions(
			placeAt(
				existing.map((s) => s.id),
				row.id,
				index
			),
			async (id, position) =>
				await tx.update(substates).set({ position }).where(eq(substates.id, id))
		);

		// Follows the Substate rule in CONTEXT.md.
		const moved: number[] = [];
		if (existing.length === 0) {
			await tx.update(states).set({ defaultSubstateId: row.id }).where(eq(states.id, stateId));
			const unplaced = and(eq(labours.stateId, stateId), isNull(labours.substateId));
			for (const labour of await tx.select({ id: labours.id }).from(labours).where(unplaced)) {
				moved.push(labour.id);
			}
			await tx.update(labours).set({ substateId: row.id, updatedAt: new Date() }).where(unplaced);
		}
		return {
			value: await getSubstate(tx, row.id),
			events: [
				await substateEvent(tx, 'substate.created', row),
				...(await mapSeq(moved, async (id): Promise<EventSpec> => ({
					type: 'labour.updated',
					data: { labour: await readLabour(tx, id) }
				})))
			]
		};
	});
}

export async function updateSubstate(
	db: Db,
	actor: Actor,
	substateId: number,
	patch: StyleUpdate
): Promise<Substate> {
	return write(db, actor, async (tx) => {
		const substate = await getSubstate(tx, substateId);
		await requireRealmRole(tx, actor, (await getState(tx, substate.stateId)).realmId, 'owner');
		const update = normalizeUpdate(patch, 'Substate');
		if (!changes(substate, update)) return { value: substate, events: [] };
		const value = (
			await tx.update(substates).set(update).where(eq(substates.id, substateId)).returning()
		)[0];
		return { value, events: [await substateEvent(tx, 'substate.updated', substate)] };
	});
}

export async function moveSubstate(
	db: Db,
	actor: Actor,
	substateId: number,
	index: number
): Promise<Substate> {
	return write(db, actor, async (tx) => {
		const substate = await getSubstate(tx, substateId);
		await requireRealmRole(tx, actor, (await getState(tx, substate.stateId)).realmId, 'owner');
		const rows = (await listSubstates(tx, substate.stateId)).map((s) => s.id);
		const order = placeAt(
			rows.filter((id) => id !== substateId),
			substateId,
			index
		);
		if (order.every((id, i) => rows[i] === id)) return { value: substate, events: [] };
		await writePositions(
			order,
			async (id, position) =>
				await tx.update(substates).set({ position }).where(eq(substates.id, id))
		);
		return {
			value: await getSubstate(tx, substateId),
			events: [await substateEvent(tx, 'substate.updated', substate)]
		};
	});
}

export async function deleteSubstate(db: Db, actor: Actor, substateId: number): Promise<void> {
	await write(db, actor, async (tx) => {
		const substate = await getSubstate(tx, substateId);
		await requireRealmRole(tx, actor, (await getState(tx, substate.stateId)).realmId, 'owner');
		const state = await getState(tx, substate.stateId);
		if (state.defaultSubstateId === substateId && (await listSubstates(tx, state.id)).length > 1) {
			throw new DomainError('conflict', 'Set another default Substate before removing this one');
		}
		const held = (
			await tx
				.select({ id: labours.id })
				.from(labours)
				.where(eq(labours.substateId, substateId))
				.limit(1)
		)[0];
		if (held) throw new DomainError('conflict', 'The Substate still holds Labours');

		await tx.delete(substates).where(eq(substates.id, substateId));
		await writePositions(
			(await listSubstates(tx, state.id)).map((s) => s.id),
			async (id, position) =>
				await tx.update(substates).set({ position }).where(eq(substates.id, id))
		);
		return { value: undefined, events: [await substateEvent(tx, 'substate.deleted', substate)] };
	});
}

export async function setDefaultSubstate(
	db: Db,
	actor: Actor,
	stateId: number,
	substateId: number
): Promise<State> {
	return write(db, actor, async (tx) => {
		const state = await getState(tx, stateId);
		await requireRealmRole(tx, actor, state.realmId, 'owner');
		const substate = await getSubstate(tx, substateId);
		if (substate.stateId !== state.id) {
			throw new DomainError('invalid', 'The default Substate must belong to the State');
		}
		if (state.defaultSubstateId === substateId) return { value: state, events: [] };
		const value = (
			await tx
				.update(states)
				.set({ defaultSubstateId: substateId })
				.where(eq(states.id, stateId))
				.returning()
		)[0];
		return { value, events: [await stateEvent(tx, 'state.updated', state.realmId, stateId)] };
	});
}

function changes<T extends object>(row: T, update: Partial<T>): boolean {
	return (Object.keys(update) as (keyof T)[]).some((key) => update[key] !== row[key]);
}
