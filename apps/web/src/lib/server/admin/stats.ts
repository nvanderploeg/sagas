import { sql } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { migrationTags } from '#lib/server/db/migrations.ts';
import { buildSchema } from './manifest.ts';
import { BUNDLE_TABLES, DERIVED_TABLES, quote } from './tables.ts';

export type AdminStats = {
	appVersion: string;
	databaseBytes: number;
	tables: { name: string; rows: number }[];
	migrations: { tag: string; date: string }[];
	buildMigrations: number;
};

export async function adminStats(db: Db): Promise<AdminStats> {
	const size = (
		await db.execute<{ bytes: number }>(sql`SELECT pg_database_size(current_database()) AS bytes`)
	).rows[0];
	const tables: AdminStats['tables'] = [];
	for (const name of [...BUNDLE_TABLES.map((entry) => entry.name), ...DERIVED_TABLES]) {
		const counted = await db.execute<{ n: number }>(
			sql.raw(`SELECT count(*) AS n FROM ${quote(name)}`)
		);
		tables.push({ name, rows: counted.rows[0].n });
	}
	tables.sort((a, b) => (a.name < b.name ? -1 : 1));
	const applied = (
		await db.execute<{ created_at: number }>(
			sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id`
		)
	).rows;
	const tags = migrationTags();
	return {
		appVersion: __APP_VERSION__,
		databaseBytes: size.bytes,
		tables,
		migrations: applied.map((row) => ({
			tag: tags.get(row.created_at) ?? String(row.created_at),
			date: new Date(row.created_at).toISOString().slice(0, 10)
		})),
		buildMigrations: buildSchema().level
	};
}
