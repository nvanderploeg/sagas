import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import type pg from 'pg';
import { loadMigrations } from './migrations.ts';

const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 2_000;
export const MIGRATION_LOCK = 7_262_024_001;

type Migrator = {
	dialect: {
		migrate: (migrations: MigrationMeta[], session: unknown, config: unknown) => Promise<void>;
	};
	session: unknown;
};

// Safe to run from several processes at once: the advisory lock serialises them on a client of
// its own, and the migrator runs on that same session.
export async function bootstrap(pool: pg.Pool, attempts = CONNECT_ATTEMPTS): Promise<void> {
	await waitForDatabase(pool, attempts);
	const lock = await pool.connect();
	lock.on('error', () => {});
	try {
		await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
		const { dialect, session } = drizzle(lock) as unknown as Migrator;
		await dialect.migrate(loadMigrations(), session, {
			migrationsTable: 'sagas_migrations',
			migrationsSchema: 'drizzle'
		});
	} finally {
		await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
		lock.release();
	}
}

async function waitForDatabase(pool: pg.Pool, attempts: number): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await pool.query('SELECT 1');
			return;
		} catch (error) {
			if (attempt >= attempts) throw error;
			console.warn(`Database not reachable (attempt ${attempt}/${attempts}); retrying`);
			await sleep(CONNECT_DELAY_MS);
		}
	}
}
