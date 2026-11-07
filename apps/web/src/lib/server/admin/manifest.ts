import { z } from 'zod';
import { loadMigrations } from '#lib/server/db/migrations.ts';

export const FORMAT = 2;
export const LEGACY_FORMAT = 1;
// Migrations applied by the last SQLite build; a legacy Bundle never holds more.
export const LEGACY_LEVEL = 25;
export const SERVICE = 'sagas';
export const MANIFEST_NAME = 'manifest.json';
export const DATABASE_NAME = 'db.ndjson';
export const LEGACY_DATABASE_NAME = 'db/sagas.db';
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export class BundleError extends Error {}

export type Schema = { level: number; latest: number };

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const manifestSchema = z.object({
	format: z.number().int(),
	service: z.string().max(100).optional(),
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
		.max(1000)
});

export type Manifest = z.infer<typeof manifestSchema>;

export function parseManifest(text: string): Manifest {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new BundleError('manifest.json is not valid JSON');
	}
	const parsed = manifestSchema.safeParse(json);
	if (!parsed.success) throw new BundleError('manifest.json is malformed');
	return parsed.data;
}

export function buildSchema(): Schema {
	const migrations = loadMigrations();
	return { level: migrations.length, latest: migrations.at(-1)?.folderMillis ?? 0 };
}
