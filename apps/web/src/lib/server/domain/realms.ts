import { asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import type { EventSpec } from '../events/types.ts';
import { realmKeys, realms, labours } from '../db/schema.ts';
import { falloutEvents, prepareLabourDelete } from './cascade.ts';
import { DomainError } from './errors.ts';
import { getRealm, getState } from './lookup.ts';
import { realmEvent } from './realm-view.ts';
import { CLOSED_STATE, insertState, type StyleSpec } from './states.ts';
import { formatLabourKey, normalizeRealmKey } from './keys.ts';
import { recordLabourKey } from './labours.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export type Realm = typeof realms.$inferSelect;
export { readBoard, readRealm, type BoardView, type RealmView } from './realm-view.ts';

export function listRealms(db: Handle) {
	return db.select().from(realms).orderBy(asc(realms.id)).all();
}

export function createRealm(
	db: Db,
	actor: Actor,
	input: { name: string; key: string; initialState: StyleSpec }
): Realm {
	return createRealmWithStates(db, actor, { ...input, states: [] });
}

// `states` are States before Closed, after the Initial State, in order. One write and one Event.
export function createRealmWithStates(
	db: Db,
	actor: Actor,
	input: { name: string; key: string; initialState: StyleSpec; states: StyleSpec[] }
): Realm {
	const name = requireText(input.name, 'Realm name', 120);
	const key = normalizeRealmKey(input.key);
	return write(db, actor, (tx) => {
		assertKeyAvailable(tx, key, null);
		const realm = tx.insert(realms).values({ name, key }).returning().get();
		tx.insert(realmKeys).values({ key, realmId: realm.id }).run();
		insertState(tx, realm.id, CLOSED_STATE, { closed: true });
		const initial = insertState(tx, realm.id, input.initialState);
		for (const state of input.states) insertState(tx, realm.id, state);
		const value = tx
			.update(realms)
			.set({ initialStateId: initial.id })
			.where(eq(realms.id, realm.id))
			.returning()
			.get();
		return { value, events: [realmEvent(tx, 'realm.created', realm.id)] };
	});
}

export function updateRealm(db: Db, actor: Actor, realmId: number, patch: { name: string }): Realm {
	return write(db, actor, (tx) => {
		const realm = getRealm(tx, realmId);
		const name = requireText(patch.name, 'Realm name', 120);
		if (name === realm.name) return { value: realm, events: [] };
		const value = tx.update(realms).set({ name }).where(eq(realms.id, realmId)).returning().get();
		return { value, events: [realmEvent(tx, 'realm.updated', realmId)] };
	});
}

export function renameRealmKey(db: Db, actor: Actor, realmId: number, input: string): Realm {
	return write(db, actor, (tx) => {
		const realm = getRealm(tx, realmId);
		const key = normalizeRealmKey(input);
		if (key === realm.key) return { value: realm, events: [] };
		assertKeyAvailable(tx, key, realmId);

		tx.insert(realmKeys).values({ key, realmId }).onConflictDoNothing().run();
		const held = tx
			.select({ id: labours.id, number: labours.number })
			.from(labours)
			.where(eq(labours.realmId, realmId))
			.orderBy(asc(labours.id))
			.all();
		const rekeyed = held.map((labour) => ({
			id: labour.id,
			previousKey: formatLabourKey(realm.key, labour.number),
			key: formatLabourKey(key, labour.number)
		}));
		for (const labour of rekeyed) recordLabourKey(tx, labour.id, labour.key);
		const value = tx.update(realms).set({ key }).where(eq(realms.id, realmId)).returning().get();
		const events: EventSpec[] = [realmEvent(tx, 'realm.updated', realmId)];
		if (rekeyed.length > 0) {
			events.push({ type: 'labour.rekeyed', data: { realmId, labours: rekeyed } });
		}
		return { value, events };
	});
}

export function setInitialState(db: Db, actor: Actor, realmId: number, stateId: number): Realm {
	return write(db, actor, (tx) => {
		const realm = getRealm(tx, realmId);
		const state = getState(tx, stateId);
		if (state.realmId !== realmId) {
			throw new DomainError('invalid', 'The Initial State must belong to the Realm');
		}
		if (state.isClosed) throw new DomainError('invalid', 'The Initial State cannot be Closed');
		if (realm.initialStateId === stateId) return { value: realm, events: [] };
		const value = tx
			.update(realms)
			.set({ initialStateId: stateId })
			.where(eq(realms.id, realmId))
			.returning()
			.get();
		return { value, events: [realmEvent(tx, 'realm.updated', realmId)] };
	});
}

export function deleteRealm(db: Db, actor: Actor, realmId: number): void {
	write(db, actor, (tx) => {
		getRealm(tx, realmId);
		const held = eq(labours.realmId, realmId);
		const labourIds = tx
			.select({ id: labours.id })
			.from(labours)
			.where(held)
			.orderBy(asc(labours.id))
			.all()
			.map((row) => row.id);
		const fallout = prepareLabourDelete(tx, held);
		tx.delete(realms).where(eq(realms.id, realmId)).run();
		return {
			value: undefined,
			events: [
				{ type: 'realm.deleted', data: { realmId, labourIds } },
				...falloutEvents(tx, fallout)
			]
		};
	});
}

function assertKeyAvailable(db: Handle, key: string, selfId: number | null): void {
	const holder = db.select().from(realmKeys).where(eq(realmKeys.key, key)).get();
	if (holder && holder.realmId !== selfId) {
		throw new DomainError('conflict', `Realm key ${key} is already in use`);
	}
}
