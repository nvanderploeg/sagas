import { mapSeq } from '#lib/server/async.ts';
import { and, asc, eq, gte, inArray, or } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { labours, stateFlows, states } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { getRealm, getState } from './lookup.ts';
import { listStates, listSubstates } from './states.ts';
import { selectLabourViews, toLabourView, type LabourView } from './labour-view.ts';

export type RealmView = Awaited<ReturnType<typeof readRealm>>;

export type BoardView = { realm: RealmView; labours: LabourView[] };

// Never include labourCounter: every Labour created moves it, and no Realm Event announces that.
export async function readRealm(db: Handle, realmId: number) {
	const { id, name, key, initialStateId } = await getRealm(db, realmId);
	const rows = await listStates(db, realmId);
	const flows = await db
		.select()
		.from(stateFlows)
		.where(
			inArray(
				stateFlows.fromStateId,
				rows.map((s) => s.id)
			)
		);
	const targets = new Map<number, Set<number>>();
	for (const f of flows) {
		targets.set(f.fromStateId, (targets.get(f.fromStateId) ?? new Set()).add(f.toStateId));
	}
	const states = await mapSeq(rows, async (state) => ({
		...state,
		substates: await listSubstates(db, state.id),
		next: rows.filter((to) => targets.get(state.id)?.has(to.id)).map((to) => to.id)
	}));
	return { id, name, key, initialStateId, states };
}

export const BOARD_CLOSED_DAYS = 14;

// Labours come grouped by State and in Rank order within each. A Closed Labour
// untouched for BOARD_CLOSED_DAYS is left off.
export async function readBoard(db: Handle, realmId: number): Promise<BoardView> {
	const cutoff = new Date(Date.now() - BOARD_CLOSED_DAYS * 24 * 60 * 60 * 1000);
	return {
		realm: await readRealm(db, realmId),
		labours: (
			await selectLabourViews(db)
				.where(
					and(
						eq(labours.realmId, realmId),
						or(eq(states.isClosed, false), gte(labours.updatedAt, cutoff))
					)
				)
				.orderBy(asc(labours.stateId), asc(labours.rank))
		).map(toLabourView)
	};
}

export async function realmEvent(
	db: Handle,
	type: 'realm.created' | 'realm.updated',
	realmId: number
): Promise<EventSpec> {
	return { type, data: { realm: await readRealm(db, realmId) } };
}

export async function stateEvent(
	db: Handle,
	type: 'state.created' | 'state.updated' | 'state.deleted',
	realmId: number,
	stateId: number
): Promise<EventSpec> {
	return { type, data: { realm: await readRealm(db, realmId), stateId } };
}

export async function substateEvent(
	db: Handle,
	type: 'substate.created' | 'substate.updated' | 'substate.deleted',
	substate: { id: number; stateId: number }
): Promise<EventSpec> {
	const { realmId } = await getState(db, substate.stateId);
	return {
		type,
		data: {
			realm: await readRealm(db, realmId),
			stateId: substate.stateId,
			substateId: substate.id
		}
	};
}
