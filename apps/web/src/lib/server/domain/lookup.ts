import { eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realms, states, substates, labours, users } from '../db/schema.ts';
import { DomainError } from './errors.ts';

function must<T>(row: T | undefined, what: string): T {
	if (row === undefined) throw new DomainError('not_found', `${what} not found`);
	return row;
}

export async function getRealm(db: Handle, id: number) {
	return must((await db.select().from(realms).where(eq(realms.id, id)).limit(1))[0], 'Realm');
}

export async function getState(db: Handle, id: number) {
	return must((await db.select().from(states).where(eq(states.id, id)).limit(1))[0], 'State');
}

export async function getSubstate(db: Handle, id: number) {
	return must(
		(await db.select().from(substates).where(eq(substates.id, id)).limit(1))[0],
		'Substate'
	);
}

export async function getLabour(db: Handle, id: number) {
	return must((await db.select().from(labours).where(eq(labours.id, id)).limit(1))[0], 'Labour');
}

export async function getUser(db: Handle, id: number) {
	return must((await db.select().from(users).where(eq(users.id, id)).limit(1))[0], 'User');
}

export async function requireUser(db: Handle, id: number, field: string): Promise<number> {
	const row = (await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1))[0];
	if (row === undefined) throw new DomainError('invalid', `${field} does not exist`);
	return row.id;
}
