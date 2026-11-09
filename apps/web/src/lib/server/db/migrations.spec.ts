import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testDb } from '#lib/server/test/db.ts';

describe('the baseline migration', () => {
	it('puts COLLATE "C" on every text column, so ranks, slugs and paths sort bytewise', async () => {
		const db = await testDb();

		const rows = (
			await db.$client.query<{
				table_name: string;
				column_name: string;
				collation_name: string | null;
			}>(
				`SELECT table_name, column_name, collation_name FROM information_schema.columns
				 WHERE table_schema = 'public' AND data_type = 'text'`
			)
		).rows;

		expect(rows.length).toBeGreaterThan(50);
		expect(rows.filter((row) => row.collation_name !== 'C')).toEqual([]);
	});

	it.each([
		['sagas_labours', 'rank'],
		['sagas_quest_labours', 'rank'],
		['sagas_scrolls', 'rank'],
		['sagas_scrolls', 'slug'],
		['sagas_scrolls', 'path'],
		['sagas_scroll_paths', 'path'],
		['sagas_labour_keys', 'key'],
		['sagas_realm_keys', 'key'],
		['sagas_realms', 'key']
	])('collates %s.%s as C', async (table, column) => {
		const db = await testDb();

		const row = (
			await db.$client.query<{ collation: string | null }>(
				`SELECT c.collname AS collation
				 FROM pg_attribute a
				 JOIN pg_class t ON t.oid = a.attrelid
				 JOIN pg_collation c ON c.oid = a.attcollation
				 WHERE t.relname = $1 AND a.attname = $2`,
				[table, column]
			)
		).rows[0];

		expect(row?.collation).toBe('C');
	});

	it('orders fractional-index ranks by byte, not by locale', async () => {
		const db = await testDb();

		const sorted = (
			await db.$client.query<{ r: string }>(
				`SELECT r FROM (VALUES ('a0'), ('Zz'), ('a1V'), ('B'), ('a')) AS v(r)
				 ORDER BY r COLLATE "C"`
			)
		).rows.map((row) => row.r);

		expect(sorted).toEqual(['B', 'Zz', 'a', 'a0', 'a1V']);
	});

	it('defers every foreign key, so an import can load tables in any order', async () => {
		const db = await testDb();

		const rows = (
			await db.$client.query<{ conname: string; condeferrable: boolean }>(
				`SELECT conname, condeferrable FROM pg_constraint WHERE contype = 'f'`
			)
		).rows;

		expect(rows.length).toBeGreaterThan(50);
		expect(rows.filter((row) => !row.condeferrable)).toEqual([]);
	});

	it('stems English without dropping stop words, so a query word like AND still matches', async () => {
		const db = await testDb();

		const row = (
			await db.$client.query<{ v: string }>(
				"SELECT to_tsvector('sagas_english', 'Save and loading dragons')::text AS v"
			)
		).rows[0];

		expect(row.v).toBe("'and':2 'dragon':4 'load':3 'save':1");
	});

	it('starts the event counter at zero in a single row', async () => {
		const db = await testDb();

		expect((await db.$client.query('SELECT id, last FROM sagas_event_counter')).rows).toEqual([
			{ id: 1, last: 0 }
		]);
	});

	it('indexes the full-text columns', async () => {
		const db = await testDb();

		const rows = (
			await db.$client.query<{ indexname: string }>(
				`SELECT indexname FROM pg_indexes WHERE indexdef ILIKE '%USING gin%'`
			)
		).rows.map((row) => row.indexname);

		expect(rows.sort()).toEqual(['sagas_labour_text_search_idx', 'sagas_scroll_text_search_idx']);
	});

	it('has a schema.ts and snapshot that drizzle-kit generate finds no difference in', () => {
		const root = resolve(import.meta.dirname, '../../../..');
		const scratch = mkdtempSync(join(tmpdir(), 'sagas-drift-'));
		try {
			cpSync(join(root, 'drizzle'), join(scratch, 'drizzle'), { recursive: true });
			writeFileSync(
				join(scratch, 'drizzle.config.ts'),
				`export default { schema: ${JSON.stringify(join(root, 'src/lib/server/db/schema.ts'))}, out: './drizzle', dialect: 'postgresql' };\n`
			);

			const run = spawnSync(
				join(root, 'node_modules/.bin/drizzle-kit'),
				['generate', '--config', 'drizzle.config.ts', '--name', 'drift'],
				{ cwd: scratch, encoding: 'utf8' }
			);

			expect(run.stdout + run.stderr).toContain('No schema changes');
			expect(readdirSync(join(scratch, 'drizzle')).filter((n) => n.endsWith('.sql'))).toEqual([
				'0000_baseline.sql',
				'0001_user_banned_at.sql'
			]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 60_000);
});
