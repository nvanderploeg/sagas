import { and, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { projectKeys, states, substates, users } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { parseTicketKey } from '../domain/keys.ts';
import { getProject, getState, getSubstate } from '../domain/lookup.ts';
import { getQuest } from '../domain/quest-view.ts';
import type { Placement } from '../domain/rank.ts';
import { listStates, listSubstates } from '../domain/states.ts';
import { readTicket, resolveTicketKey } from '../domain/tickets.ts';

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

function ticketById(db: Handle, id: number) {
	try {
		return readTicket(db, id);
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') {
			return notFound(`No Ticket has the id ${id}`);
		}
		throw error;
	}
}

export function ticketId(db: Handle, ref: Ref): number {
	if (typeof ref === 'number') return ticketById(db, ref).id;
	const key = text(ref, 'a Ticket key');
	if (parseTicketKey(key) === null) {
		throw new DomainError('invalid', `"${key}" is not a Ticket key, e.g. "AM-12"`);
	}
	return resolveTicketKey(db, key)?.id ?? notFound(`No Ticket has the key ${key.toUpperCase()}`);
}

export function ticketKey(db: Handle, id: number): string {
	return readTicket(db, id).key;
}

export function projectId(db: Handle, ref: Ref): number {
	if (typeof ref === 'number') return getProject(db, ref).id;
	const key = text(ref, 'a Project key').toUpperCase();
	const row = db.select().from(projectKeys).where(eq(projectKeys.key, key)).get();
	return row?.projectId ?? notFound(`No Project has the key ${key}`);
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

export function stateId(db: Handle, project: number | undefined, ref: Ref): number {
	if (typeof ref === 'number') {
		const state = getState(db, ref);
		if (project !== undefined && state.projectId !== project) {
			throw new DomainError('invalid', 'The State belongs to another Project');
		}
		return state.id;
	}
	const key = text(ref, 'a State key').toLowerCase();
	if (project === undefined) {
		throw new DomainError('invalid', `Name the Project to look up State "${key}"`);
	}
	const row = db
		.select({ id: states.id })
		.from(states)
		.where(and(eq(states.projectId, project), eq(states.key, key)))
		.get();
	if (row) return row.id;
	const known = listStates(db, project).map((s) => s.key);
	return notFound(
		`No State "${key}" in ${getProject(db, project).key}; its States are ${known.join(', ')}`
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
	if (args.before !== undefined) return { before: ticketId(db, args.before) };
	if (args.after !== undefined) return { after: ticketId(db, args.after) };
	return undefined;
}
