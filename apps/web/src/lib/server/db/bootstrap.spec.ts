import { describe, expect, it } from 'vitest';
import { adminPool, assertTestDatabase, urlFor } from '#lib/server/test/db.ts';
import { bootstrap } from './bootstrap.ts';
import { createPool } from './client.ts';
import { loadMigrations } from './migrations.ts';

async function freshDatabase() {
	const name = `sagas_boot_${Math.random().toString(36).slice(2, 10)}_test`;
	assertTestDatabase(name);
	await adminPool().query(`CREATE DATABASE "${name}"`);
	return {
		name,
		drop: () => adminPool().query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
	};
}

describe('bootstrap', () => {
	it('survives several pods starting at once on a fresh database', async () => {
		const { name, drop } = await freshDatabase();
		const pools = Array.from({ length: 6 }, () => createPool(urlFor(name), { max: 3 }));
		try {
			await Promise.all(pools.map((pool) => bootstrap(pool)));

			const applied = await pools[0].query(
				'SELECT count(*)::int AS n FROM drizzle.sagas_migrations'
			);
			expect(applied.rows[0].n).toBe(loadMigrations().length);
			const tables = await pools[0].query(
				"SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sagas_users'"
			);
			expect(tables.rows[0].n).toBe(1);
		} finally {
			await Promise.all(pools.map((pool) => pool.end()));
			await drop();
		}
	});

	it('applies nothing the second time', async () => {
		const { name, drop } = await freshDatabase();
		const pool = createPool(urlFor(name), { max: 2 });
		try {
			await bootstrap(pool);
			await bootstrap(pool);

			const applied = await pool.query('SELECT count(*)::int AS n FROM drizzle.sagas_migrations');
			expect(applied.rows[0].n).toBe(loadMigrations().length);
		} finally {
			await pool.end();
			await drop();
		}
	});

	it('waits for a database that is not up yet, then gives up', async () => {
		const pool = createPool('postgres://nobody:none@127.0.0.1:1/none', {
			connectionTimeoutMillis: 200
		});
		try {
			await expect(bootstrap(pool, 2)).rejects.toThrow();
		} finally {
			await pool.end().catch(() => undefined);
		}
	});
});
