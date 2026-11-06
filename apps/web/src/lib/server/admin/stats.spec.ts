import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase } from '#lib/server/db/client.ts';
import { seedRealm } from '#lib/server/test/fixtures.ts';
import { buildSchema } from './manifest.ts';
import { adminStats } from './stats.ts';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'sagas-stats-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('reports sizes, row counts, applied migrations and attachments', async () => {
	const databaseFile = join(dir, 'sagas.db');
	const db = openDatabase(databaseFile);
	seedRealm(db);
	db.$client.exec('CREATE TABLE labour_text_extra (id integer)');
	mkdirSync(join(dir, 'attachments/x'), { recursive: true });
	writeFileSync(join(dir, 'attachments/x/f.bin'), '12345');

	const stats = await adminStats(db, {
		dataDir: dir,
		databaseFile,
		attachmentsDir: join(dir, 'attachments')
	});

	expect(stats.databaseBytes).toBeGreaterThan(0);
	expect(stats.tables.find((t) => t.name === 'realms')).toEqual({ name: 'realms', rows: 1 });
	expect(stats.tables.map((t) => t.name)).toContain('labour_vectors');
	expect(stats.tables.map((t) => t.name)).not.toContain('labour_text_data');
	expect(stats.tables.map((t) => t.name)).toContain('labour_text_extra');
	expect(stats.migrations).toHaveLength(buildSchema().level);
	expect(stats.migrations[0].tag).toBe('0000_' + stats.migrations[0].tag.slice(5));
	expect(stats.attachments).toEqual({ files: 1, bytes: 5 });
	db.$client.close();
});
