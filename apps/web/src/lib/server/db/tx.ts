import { sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { Handle } from './client.ts';

// Every writing transaction takes this lock first, so writers run one at a time.
export const WRITER_LOCK = 7_262_024_002;

const turns = new WeakMap<object, Promise<unknown>>();
let open = 0;

// True from a transaction's first statement until its COMMIT or ROLLBACK has returned.
export const inTransaction = (): boolean => open > 0;

async function counted<T>(run: () => Promise<T>): Promise<T> {
	open += 1;
	try {
		return await run();
	} finally {
		open -= 1;
	}
}

// Queue writers here, not on the lock: a waiting writer must hold no connection.
function exclusive<T>(pool: object, run: () => Promise<T>): Promise<T> {
	const result = (turns.get(pool) ?? Promise.resolve()).then(run, run);
	turns.set(
		pool,
		result.catch(() => undefined)
	);
	return result;
}

export function transact<T>(db: Handle, body: (tx: Handle) => Promise<T>): Promise<T> {
	if (db instanceof PgTransaction) return db.transaction((tx) => body(tx as unknown as Handle));
	return exclusive((db as unknown as { $client: object }).$client, () =>
		counted(() =>
			db.transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(${WRITER_LOCK})`);
				return body(tx);
			})
		)
	);
}

// One snapshot for every read in `body`; takes no writer lock.
export function readSnapshot<T>(db: Handle, body: (tx: Handle) => Promise<T>): Promise<T> {
	return counted(() =>
		db.transaction(body, { isolationLevel: 'repeatable read', accessMode: 'read only' })
	);
}
