import type { Realm, State, Substate, Labour } from '../live/types.ts';

export const FALLBACK_STATE = { label: 'Unknown', color: '#9ca3af', icon: 'question' };

export function stateOf(
	realms: Realm[],
	labour: Pick<Labour, 'realmId' | 'stateId' | 'substateId'>
): { realm: Realm | undefined; state: State | undefined; substate: Substate | undefined } {
	const realm = realms.find((p) => p.id === labour.realmId);
	const state = realm?.states.find((s) => s.id === labour.stateId);
	const substate = state?.substates.find((s) => s.id === labour.substateId);
	return { realm, state, substate };
}

export const byRecent = (a: { updatedAt: string }, b: { updatedAt: string }) =>
	a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
