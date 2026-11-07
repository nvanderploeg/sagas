import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

// A Db or a transaction on one.
export type Handle = PgDatabase<NodePgQueryResultHKT, typeof schema>;

const INT8 = 20;
const NUMERIC = 1700;

// Epoch milliseconds, counts and sums stay below 2^53: hand them over as numbers, not strings.
pg.types.setTypeParser(INT8, Number);
pg.types.setTypeParser(NUMERIC, Number);

const SESSION_SETTINGS = `SET idle_in_transaction_session_timeout = 600000; SET statement_timeout = 60000`;

const report = (error: Error) => console.error(`database connection error: ${error.message}`);

// The client's own 'error' listener outlives checkout: the pool detaches its listener then.
class SessionClient extends pg.Client {
	constructor(config?: string | pg.ClientConfig) {
		super(config);
		this.on('error', report);
	}

	connect(): Promise<this>;
	connect(callback: ((err: Error) => void) | ((err: null, client: this) => void)): void;
	connect(
		callback?: ((err: Error) => void) | ((err: null, client: this) => void)
	): Promise<this> | void {
		const ready = super.connect().then(async () => {
			await this.query(SESSION_SETTINGS);
			return this;
		});
		if (!callback) return ready;
		ready.then(
			(client) => (callback as (err: null, client: this) => void)(null, client),
			(error: Error) => (callback as (err: Error) => void)(error)
		);
	}
}

export function createPool(connectionString: string, options: pg.PoolConfig = {}): pg.Pool {
	const pool = new pg.Pool({
		connectionString,
		Client: SessionClient,
		max: 10,
		keepAlive: true,
		connectionTimeoutMillis: 10_000,
		...options
	});
	pool.on('error', report);
	return pool;
}

export function openDatabase(pool: pg.Pool): Db {
	return drizzle(pool, { schema });
}
