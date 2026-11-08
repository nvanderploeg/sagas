import { and, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realmKeys, scrolls, states, substates, users } from '../db/schema.ts';
import { canSeeRealm } from '../domain/access.ts';
import { DomainError } from '../domain/errors.ts';
import { parseLabourKey } from '../domain/keys.ts';
import { getRealm, getState, getSubstate } from '../domain/lookup.ts';
import { getQuest } from '../domain/quest-view.ts';
import { getRecurrence } from '../domain/recurrences.ts';
import type { Placement } from '../domain/rank.ts';
import { listStates, listSubstates } from '../domain/states.ts';
import { readLabour, resolveLabourKey } from '../domain/labours.ts';
import { resolveScrollPath } from '../domain/scrolls.ts';
import { normalizePath } from '../../ui/scroll-path.ts';

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

async function labourById(db: Handle, id: number) {
	try {
		return await readLabour(db, id);
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') {
			return notFound(`No Labour has the id ${id}`);
		}
		throw error;
	}
}

type Viewer = { id: number };

// A Labour in a Realm the viewer cannot see is not found, worded as for one that doesn't exist.
export async function labourId(db: Handle, ref: Ref, viewer: Viewer): Promise<number> {
	if (typeof ref === 'number') {
		const found = await labourById(db, ref);
		return (await canSeeRealm(db, viewer, found.realmId))
			? found.id
			: notFound(`No Labour has the id ${ref}`);
	}
	const key = text(ref, 'a Labour key');
	if (parseLabourKey(key) === null) {
		throw new DomainError('invalid', `"${key}" is not a Labour key, e.g. "AM-12"`);
	}
	const found = await resolveLabourKey(db, key);
	return found && (await canSeeRealm(db, viewer, found.realmId))
		? found.id
		: notFound(`No Labour has the key ${key.toUpperCase()}`);
}

export async function labourKey(db: Handle, id: number): Promise<string> {
	return (await readLabour(db, id)).key;
}

export async function realmId(db: Handle, ref: Ref, viewer: Viewer): Promise<number> {
	if (typeof ref === 'number') {
		const id = (await getRealm(db, ref)).id;
		return (await canSeeRealm(db, viewer, id)) ? id : notFound('Realm not found');
	}
	const key = text(ref, 'a Realm key').toUpperCase();
	const row = (await db.select().from(realmKeys).where(eq(realmKeys.key, key)).limit(1))[0];
	return row && (await canSeeRealm(db, viewer, row.realmId))
		? row.realmId
		: notFound(`No Realm has the key ${key}`);
}

export async function username(db: Handle, id: number): Promise<string | undefined> {
	return (
		await db.select({ username: users.username }).from(users).where(eq(users.id, id)).limit(1)
	)[0]?.username;
}

// "me" is the caller, whatever the usernames.
export async function userId(db: Handle, ref: Ref, me: { id: number }): Promise<number> {
	if (typeof ref === 'number') {
		const row = (
			await db.select({ id: users.id }).from(users).where(eq(users.id, ref)).limit(1)
		)[0];
		return row?.id ?? notFound(`No User has the id ${ref}`);
	}
	const username = text(ref, 'a username or "me"').toLowerCase();
	if (username === 'me') return me.id;
	const row = (
		await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1)
	)[0];
	return row?.id ?? notFound(`No User is named "${username}"`);
}

// A Quest in a Realm the viewer cannot see is not found.
export async function questId(db: Handle, id: number, viewer: Viewer): Promise<number> {
	const quest = await getQuest(db, id);
	return (await canSeeRealm(db, viewer, quest.realmId)) ? quest.id : notFound('Quest not found');
}

// A Recurrence in a Realm the viewer cannot see is not found.
export async function recurrenceId(db: Handle, id: number, viewer: Viewer): Promise<number> {
	const recurrence = await getRecurrence(db, id);
	return (await canSeeRealm(db, viewer, recurrence.realmId))
		? recurrence.id
		: notFound('Recurrence not found');
}

export async function stateId(db: Handle, realm: number | undefined, ref: Ref): Promise<number> {
	if (typeof ref === 'number') {
		const state = await getState(db, ref);
		if (realm !== undefined && state.realmId !== realm) {
			throw new DomainError('invalid', 'The State belongs to another Realm');
		}
		return state.id;
	}
	const key = text(ref, 'a State key').toLowerCase();
	if (realm === undefined) {
		throw new DomainError('invalid', `Name the Realm to look up State "${key}"`);
	}
	const row = (
		await db
			.select({ id: states.id })
			.from(states)
			.where(and(eq(states.realmId, realm), eq(states.key, key)))
			.limit(1)
	)[0];
	if (row) return row.id;
	const known = (await listStates(db, realm)).map((s) => s.key);
	return notFound(
		`No State "${key}" in ${(await getRealm(db, realm)).key}; its States are ${known.join(', ')}`
	);
}

export async function substateId(db: Handle, state: number | undefined, ref: Ref): Promise<number> {
	if (typeof ref === 'number') {
		const substate = await getSubstate(db, ref);
		if (state !== undefined && substate.stateId !== state) {
			throw new DomainError('invalid', 'The Substate belongs to another State');
		}
		return substate.id;
	}
	const key = text(ref, 'a Substate key').toLowerCase();
	if (state === undefined) {
		throw new DomainError('invalid', `Name the State to look up Substate "${key}"`);
	}
	const row = (
		await db
			.select({ id: substates.id })
			.from(substates)
			.where(and(eq(substates.stateId, state), eq(substates.key, key)))
			.limit(1)
	)[0];
	if (row) return row.id;
	const known = (await listSubstates(db, state)).map((s) => s.key);
	const stateKey = (await getState(db, state)).key;
	return notFound(
		known.length === 0
			? `State "${stateKey}" has no Substates`
			: `No Substate "${key}" in State "${stateKey}"; its Substates are ${known.join(', ')}`
	);
}

export type PlacementArgs = { position?: 'top' | 'bottom'; before?: Ref; after?: Ref };

async function placementWith(
	args: PlacementArgs,
	resolve: (ref: Ref) => Promise<number>
): Promise<Placement | undefined> {
	const given = [args.position, args.before, args.after].filter((v) => v !== undefined);
	if (given.length > 1) {
		throw new DomainError('invalid', 'Give at most one of position, before and after');
	}
	if (args.position !== undefined) return args.position;
	if (args.before !== undefined) return { before: await resolve(args.before) };
	if (args.after !== undefined) return { after: await resolve(args.after) };
	return undefined;
}

export function placement(
	db: Handle,
	args: PlacementArgs,
	viewer: Viewer
): Promise<Placement | undefined> {
	return placementWith(args, (ref) => labourId(db, ref, viewer));
}

// A Scroll in a Realm the viewer cannot see is not found, worded as for one that doesn't exist.
// A string is always a Path, digits included: a Slug may be all digits.
export async function scrollId(
	db: Handle,
	realm: number | undefined,
	ref: Ref,
	viewer: Viewer
): Promise<number> {
	if (typeof ref === 'number') {
		const row = (
			await db
				.select({ id: scrolls.id, realmId: scrolls.realmId })
				.from(scrolls)
				.where(eq(scrolls.id, ref))
				.limit(1)
		)[0];
		if (row === undefined || !(await canSeeRealm(db, viewer, row.realmId))) {
			return notFound(`No Scroll has the id ${ref}`);
		}
		if (realm !== undefined && row.realmId !== realm) {
			throw new DomainError('invalid', `Scroll ${ref} belongs to another Realm`);
		}
		return row.id;
	}
	const path = ref.trim();
	if (realm === undefined) {
		throw new DomainError(
			'invalid',
			`Name the Realm to look up Scroll "${path}", or give the Scroll's id as a JSON number`
		);
	}
	const found = await resolveScrollPath(db, realm, path);
	return (
		found?.scroll.id ??
		notFound(
			`No Scroll has the Path ${normalizePath(path) ?? path} in ${(await getRealm(db, realm)).key}`
		)
	);
}

export function scrollPlacement(
	db: Handle,
	realm: number,
	args: PlacementArgs,
	viewer: Viewer
): Promise<Placement | undefined> {
	return placementWith(args, (ref) => scrollId(db, realm, ref, viewer));
}
