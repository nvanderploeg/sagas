import Database from 'better-sqlite3';
import { z } from 'zod';
import { loadMigrations } from '#lib/server/db/migrations.ts';
import { safeRelativePath } from './zip.ts';

export const FORMAT = 1;
export const MANIFEST_NAME = 'manifest.json';
export const DATABASE_NAME = 'db/sagas.db';
export const ATTACHMENT_PREFIX = 'attachments/';

export class BundleError extends Error {}

export type Schema = { level: number; latest: number };

export type Applied = { hash: string; createdAt: number };

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const manifestSchema = z.object({
	format: z.number().int(),
	appVersion: z.string().max(100),
	createdAt: z.string().max(40),
	schema: z.object({
		level: z.number().int().min(0),
		latest: z.number().int().min(0)
	}),
	files: z
		.array(
			z.object({
				path: z.string().max(1100),
				size: z.number().int().min(0),
				sha256
			})
		)
		.max(1_000_000),
	skipped: z
		.array(z.object({ path: z.string().max(4096), reason: z.string().max(200) }))
		.max(1_000_000)
		.default([]),
	remoteAttachments: z
		.array(z.object({ driver: z.string().max(100), key: z.string().max(2000) }))
		.max(1_000_000)
		.default([])
});

export type Manifest = z.infer<typeof manifestSchema>;

export function isBundledPath(path: string): boolean {
	if (path === DATABASE_NAME) return true;
	return (
		path.startsWith(ATTACHMENT_PREFIX) && safeRelativePath(path.slice(ATTACHMENT_PREFIX.length))
	);
}

export function buildSchema(): Schema {
	const migrations = loadMigrations();
	return { level: migrations.length, latest: migrations.at(-1)?.folderMillis ?? 0 };
}

export function appliedMigrations(sqlite: Database.Database): Applied[] {
	const exists = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
		.get();
	if (!exists) return [];
	return (
		sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all() as {
			hash: string;
			created_at: number;
		}[]
	).map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

export function schemaOf(applied: Applied[]): Schema {
	return { level: applied.length, latest: applied.at(-1)?.createdAt ?? 0 };
}

export function checkHistory(applied: Applied[]): void {
	const known = loadMigrations();
	if (applied.length > known.length) {
		throw new BundleError(
			`The bundle's schema (${applied.length} migrations) is newer than this build (${known.length}). Upgrade this server first.`
		);
	}
	applied.forEach((row, i) => {
		if (row.hash !== known[i].hash) {
			throw new BundleError('The bundle was made by a build with a different migration history');
		}
	});
}
