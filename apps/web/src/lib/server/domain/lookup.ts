import { eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realms, states, substates, labours, users } from '../db/schema.ts';
import { DomainError } from './errors.ts';

function must<T>(row: T | undefined, what: string): T {
	if (row === undefined) throw new DomainError('not_found', `${what} not found`);
	return row;
}

export function getRealm(db: Handle, id: number) {
	return must(db.select().from(realms).where(eq(realms.id, id)).get(), 'Realm');
}

export function getState(db: Handle, id: number) {
	return must(db.select().from(states).where(eq(states.id, id)).get(), 'State');
}

export function getSubstate(db: Handle, id: number) {
	return must(db.select().from(substates).where(eq(substates.id, id)).get(), 'Substate');
}

export function getLabour(db: Handle, id: number) {
	return must(db.select().from(labours).where(eq(labours.id, id)).get(), 'Labour');
}

export function getUser(db: Handle, id: number) {
	return must(db.select().from(users).where(eq(users.id, id)).get(), 'User');
}

export function requireUser(db: Handle, id: number, field: string): number {
	const row = db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
	if (row === undefined) throw new DomainError('invalid', `${field} does not exist`);
	return row.id;
}
