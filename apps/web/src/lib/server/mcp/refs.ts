import { and, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { projectKeys, states, substates, users } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { parseTicketKey } from '../domain/keys.ts';
import { getProject, getState, getSubstate, getTicket } from '../domain/lookup.ts';
import { getQuest } from '../domain/quest-view.ts';
import type { Placement } from '../domain/rank.ts';
import { listStates, listSubstates } from '../domain/states.ts';
import { resolveTicketKey } from '../domain/tickets.ts';

export type Ref = string | number;

// Keys and usernames start with a letter, so an all-digit reference is always an internal id.
function asId(ref: Ref): number | null {
	if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : null;
	const text = ref.trim();
	return /^[0-9]+$/.test(text) ? Number(text) : null;
}

function notFound(message: string): never {
	throw new DomainError('not_found', message);
}

export function ticketId(db: Handle, ref: Ref): number {
	const id = asId(ref);
	if (id !== null) return getTicket(db, id).id;
	const text = String(ref).trim();
	if (parseTicketKey(text) === null) {
		throw new DomainError('invalid', `"${text}" is neither a Ticket key nor a Ticket id`);
	}
	return resolveTicketKey(db, text)?.id ?? notFound(`No Ticket has the key ${text.toUpperCase()}`);
}

export function projectId(db: Handle, ref: Ref): number {
	const id = asId(ref);
	if (id !== null) return getProject(db, id).id;
	const key = String(ref).trim().toUpperCase();
	const row = db.select().from(projectKeys).where(eq(projectKeys.key, key)).get();
	return row?.projectId ?? notFound(`No Project has the key ${key}`);
}

export function userId(db: Handle, ref: Ref): number {
	const id = asId(ref);
	const row =
		id !== null
			? db.select({ id: users.id }).from(users).where(eq(users.id, id)).get()
			: db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.username, String(ref).trim().toLowerCase()))
					.get();
	return row?.id ?? notFound(`No User ${id ?? `"${String(ref).trim()}"`}`);
}

export function questId(db: Handle, ref: Ref): number {
	const id = asId(ref);
	if (id === null) throw new DomainError('invalid', 'A Quest is named by its id');
	return getQuest(db, id).id;
}

export function stateId(db: Handle, project: number | undefined, ref: Ref): number {
	const id = asId(ref);
	if (id !== null) {
		const state = getState(db, id);
		if (project !== undefined && state.projectId !== project) {
			throw new DomainError('invalid', 'The State belongs to another Project');
		}
		return state.id;
	}
	const key = String(ref).trim().toLowerCase();
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
	const id = asId(ref);
	if (id !== null) {
		const substate = getSubstate(db, id);
		if (state !== undefined && substate.stateId !== state) {
			throw new DomainError('invalid', 'The Substate belongs to another State');
		}
		return substate.id;
	}
	const key = String(ref).trim().toLowerCase();
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
