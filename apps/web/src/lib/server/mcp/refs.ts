import { and, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realmKeys, states, substates, users } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { parseLabourKey } from '../domain/keys.ts';
import { getRealm, getState, getSubstate } from '../domain/lookup.ts';
import { getQuest } from '../domain/quest-view.ts';
import type { Placement } from '../domain/rank.ts';
import { listStates, listSubstates } from '../domain/states.ts';
import { readLabour, resolveLabourKey } from '../domain/labours.ts';

// A number is an id; a string is a key or a username, never an id.
export type Ref = string | number;

function notFound(message: string): never {
	throw new DomainError('not_found', message);
}

function text(ref: string, what: string): string {
	const value = ref.trim();
	if (/^[0-9]+$/.test(value)) {
		throw new DomainError(
			'invalid',
			`"${value}" is a string, so it must be ${what}; give an id as a JSON number: ${value}`
		);
	}
	return value;
}

function labourById(db: Handle, id: number) {
	try {
		return readLabour(db, id);
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') {
			return notFound(`No Labour has the id ${id}`);
		}
		throw error;
	}
}

export function labourId(db: Handle, ref: Ref): number {
	if (typeof ref === 'number') return labourById(db, ref).id;
	const key = text(ref, 'a Labour key');
	if (parseLabourKey(key) === null) {
		throw new DomainError('invalid', `"${key}" is not a Labour key, e.g. "AM-12"`);
	}
	return resolveLabourKey(db, key)?.id ?? notFound(`No Labour has the key ${key.toUpperCase()}`);
}

export function labourKey(db: Handle, id: number): string {
	return readLabour(db, id).key;
}

export function realmId(db: Handle, ref: Ref): number {
	if (typeof ref === 'number') return getRealm(db, ref).id;
	const key = text(ref, 'a Realm key').toUpperCase();
	const row = db.select().from(realmKeys).where(eq(realmKeys.key, key)).get();
	return row?.realmId ?? notFound(`No Realm has the key ${key}`);
}

// "me" is the caller, whatever the usernames.
export function userId(db: Handle, ref: Ref, me: { id: number }): number {
	if (typeof ref === 'number') {
		const row = db.select({ id: users.id }).from(users).where(eq(users.id, ref)).get();
		return row?.id ?? notFound(`No User has the id ${ref}`);
	}
	const username = text(ref, 'a username or "me"').toLowerCase();
	if (username === 'me') return me.id;
	const row = db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
	return row?.id ?? notFound(`No User is named "${username}"`);
}

export function questId(db: Handle, id: number): number {
	return getQuest(db, id).id;
}

export function stateId(db: Handle, realm: number | undefined, ref: Ref): number {
	if (typeof ref === 'number') {
		const state = getState(db, ref);
		if (realm !== undefined && state.realmId !== realm) {
			throw new DomainError('invalid', 'The State belongs to another Realm');
		}
		return state.id;
	}
	const key = text(ref, 'a State key').toLowerCase();
	if (realm === undefined) {
		throw new DomainError('invalid', `Name the Realm to look up State "${key}"`);
	}
	const row = db
		.select({ id: states.id })
		.from(states)
		.where(and(eq(states.realmId, realm), eq(states.key, key)))
		.get();
	if (row) return row.id;
	const known = listStates(db, realm).map((s) => s.key);
	return notFound(
		`No State "${key}" in ${getRealm(db, realm).key}; its States are ${known.join(', ')}`
	);
}

export function substateId(db: Handle, state: number | undefined, ref: Ref): number {
	if (typeof ref === 'number') {
		const substate = getSubstate(db, ref);
		if (state !== undefined && substate.stateId !== state) {
			throw new DomainError('invalid', 'The Substate belongs to another State');
		}
		return substate.id;
	}
	const key = text(ref, 'a Substate key').toLowerCase();
	if (state === undefined) {
		throw new DomainError('invalid', `Name the State to look up Substate "${key}"`);
	}
	const row = db
		.select({ id: substates.id })
		.from(substates)
		.where(and(eq(substates.stateId, state), eq(substates.key, key)))
		.get();
	if (row) return row.id;
	const known = listSubstates(db, state).map((s) => s.key);
	const stateKey = getState(db, state).key;
	return notFound(
		known.length === 0
			? `State "${stateKey}" has no Substates`
			: `No Substate "${key}" in State "${stateKey}"; its Substates are ${known.join(', ')}`
	);
}

export type PlacementArgs = { position?: 'top' | 'bottom'; before?: Ref; after?: Ref };

export function placement(db: Handle, args: PlacementArgs): Placement | undefined {
	const given = [args.position, args.before, args.after].filter((v) => v !== undefined);
	if (given.length > 1) {
		throw new DomainError('invalid', 'Give at most one of position, before and after');
	}
	if (args.position !== undefined) return args.position;
	if (args.before !== undefined) return { before: labourId(db, args.before) };
	if (args.after !== undefined) return { after: labourId(db, args.after) };
	return undefined;
}
