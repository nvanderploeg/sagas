import { eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realms, states, labours } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { formatLabourKey } from './keys.ts';

export type Labour = typeof labours.$inferSelect;

// `closed` is whether the Labour's State is Closed.
export type LabourView = Labour & { key: string; closed: boolean };

export function selectLabourViews(db: Handle) {
	return db
		.select({ labour: labours, realmKey: realms.key, closed: states.isClosed })
		.from(labours)
		.innerJoin(realms, eq(realms.id, labours.realmId))
		.innerJoin(states, eq(states.id, labours.stateId));
}

export function toLabourView(row: {
	labour: Labour;
	realmKey: string;
	closed: boolean;
}): LabourView {
	return {
		...row.labour,
		key: formatLabourKey(row.realmKey, row.labour.number),
		closed: row.closed
	};
}

export async function readLabour(db: Handle, labourId: number): Promise<LabourView> {
	const row = (await selectLabourViews(db).where(eq(labours.id, labourId)).limit(1))[0];
	if (row === undefined) throw new DomainError('not_found', 'Labour not found');
	return toLabourView(row);
}

export function labourName(db: Handle): (id: number) => Promise<string> {
	return async (id) => {
		const row = (await selectLabourViews(db).where(eq(labours.id, id)).limit(1))[0];
		return row === undefined ? `Labour ${id}` : toLabourView(row).key;
	};
}
