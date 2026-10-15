import { asc, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { labours } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { getRealm, getState } from './lookup.ts';
import { listStates, listSubstates } from './states.ts';
import { selectLabourViews, toLabourView, type LabourView } from './labour-view.ts';

export type RealmView = ReturnType<typeof readRealm>;

export type BoardView = { realm: RealmView; labours: LabourView[] };

// Never include labourCounter: every Labour created moves it, and no Realm Event announces that.
export function readRealm(db: Handle, realmId: number) {
	const { id, name, key, initialStateId } = getRealm(db, realmId);
	const states = listStates(db, realmId).map((state) => ({
		...state,
		substates: listSubstates(db, state.id)
	}));
	return { id, name, key, initialStateId, states };
}

// Labours come grouped by State and in Rank order within each.
export function readBoard(db: Handle, realmId: number): BoardView {
	return {
		realm: readRealm(db, realmId),
		labours: selectLabourViews(db)
			.where(eq(labours.realmId, realmId))
			.orderBy(asc(labours.stateId), asc(labours.rank))
			.all()
			.map(toLabourView)
	};
}

export function realmEvent(
	db: Handle,
	type: 'realm.created' | 'realm.updated',
	realmId: number
): EventSpec {
	return { type, data: { realm: readRealm(db, realmId) } };
}

export function stateEvent(
	db: Handle,
	type: 'state.created' | 'state.updated' | 'state.deleted',
	realmId: number,
	stateId: number
): EventSpec {
	return { type, data: { realm: readRealm(db, realmId), stateId } };
}

export function substateEvent(
	db: Handle,
	type: 'substate.created' | 'substate.updated' | 'substate.deleted',
	substate: { id: number; stateId: number }
): EventSpec {
	const { realmId } = getState(db, substate.stateId);
	return {
		type,
		data: {
			realm: readRealm(db, realmId),
			stateId: substate.stateId,
			substateId: substate.id
		}
	};
}
