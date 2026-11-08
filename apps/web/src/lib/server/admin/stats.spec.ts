import { expect, it } from 'vitest';
import { testDb } from '#lib/server/test/db.ts';
import { seedRealm } from '#lib/server/test/fixtures.ts';
import { buildSchema } from './manifest.ts';
import { adminStats } from './stats.ts';

it('reports size, row counts and applied migrations', async () => {
	const db = await testDb();
	await seedRealm(db);

	const stats = await adminStats(db);

	expect(stats.databaseBytes).toBeGreaterThan(0);
	expect(stats.tables.find((t) => t.name === 'realms')).toEqual({ name: 'realms', rows: 1 });
	expect(stats.tables.map((t) => t.name)).toContain('labour_vectors');
	expect(stats.tables.map((t) => t.name)).toContain('labour_text');
	expect(stats.migrations).toHaveLength(buildSchema().level);
	expect(stats.migrations[0].tag).toBe('0000_baseline');
	expect(stats.buildMigrations).toBe(buildSchema().level);
});
