import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { RunResult } from 'better-sqlite3';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import * as schema from './schema.ts';
import { loadMigrations } from './migrations.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export type Handle = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

// drizzle exposes its migrator only through these internal fields.
type Migrator = {
	dialect: { migrate: (migrations: MigrationMeta[], session: unknown) => void };
	session: unknown;
};

export function openDatabase(file: string): Db {
	if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
	const sqlite = new Database(file);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle(sqlite, { schema });
	const { dialect, session } = db as unknown as Migrator;
	dialect.migrate(loadMigrations(), session);
	return db;
}
