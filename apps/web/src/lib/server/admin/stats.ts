import { existsSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '#lib/server/db/client.ts';
import { migrationTags } from '#lib/server/db/migrations.ts';
import type { DataLayout } from './layout.ts';
import { appliedMigrations, buildSchema } from './manifest.ts';

export type AdminStats = {
	appVersion: string;
	databaseBytes: number;
	tables: { name: string; rows: number }[];
	migrations: { tag: string; date: string }[];
	buildMigrations: number;
	attachments: { files: number; bytes: number };
};

const FTS5_SHADOWS = ['data', 'idx', 'content', 'docsize', 'config'];

function tableNames(sqlite: Db['$client']): string[] {
	const rows = sqlite
		.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all() as { name: string; sql: string }[];
	const shadows = new Set(
		rows
			.filter((r) => /^CREATE VIRTUAL TABLE\s+\S+\s+USING\s+fts5/i.test(r.sql ?? ''))
			.flatMap((r) => FTS5_SHADOWS.map((suffix) => `${r.name}_${suffix}`))
	);
	return rows
		.map((r) => r.name)
		.filter(
			(name) => !name.startsWith('sqlite_') && name !== '__drizzle_migrations' && !shadows.has(name)
		);
}

async function directoryTotals(root: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	const walk = async (dir: string): Promise<void> => {
		let items;
		try {
			items = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			if (item.isDirectory()) await walk(join(dir, item.name));
			else if (item.isFile()) {
				try {
					bytes += (await stat(join(dir, item.name))).size;
					files += 1;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			}
		}
	};
	await walk(root);
	return { files, bytes };
}

export async function adminStats(db: Db, layout: DataLayout): Promise<AdminStats> {
	const tags = migrationTags();
	const sizeOf = (file: string) => (existsSync(file) ? statSync(file).size : 0);
	return {
		appVersion: __APP_VERSION__,
		databaseBytes: sizeOf(layout.databaseFile) + sizeOf(`${layout.databaseFile}-wal`),
		tables: tableNames(db.$client).map((name) => ({
			name,
			rows: (
				db.$client.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as {
					n: number;
				}
			).n
		})),
		migrations: appliedMigrations(db.$client).map((row) => ({
			tag: tags.get(row.createdAt) ?? row.hash.slice(0, 12),
			date: new Date(row.createdAt).toISOString().slice(0, 10)
		})),
		buildMigrations: buildSchema().level,
		attachments: await directoryTotals(layout.attachmentsDir)
	};
}
