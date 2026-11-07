import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPool } from './client.ts';
import { adminPool, testDb, urlFor } from '#lib/server/test/db.ts';

describe('the connection pool', () => {
	it('applies the session settings to every connection', async () => {
		const db = await testDb();
		const rows = (
			await db.$client.query<{ name: string; setting: string }>(
				`SELECT name, setting FROM pg_settings
				 WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout')`
			)
		).rows;

		expect(Object.fromEntries(rows.map((row) => [row.name, row.setting]))).toEqual({
			statement_timeout: '60000',
			idle_in_transaction_session_timeout: '600000'
		});
	});

	it('hands out bigint as numbers, so epoch milliseconds stay numbers', async () => {
		const db = await testDb();

		const row = (await db.$client.query('SELECT 1700000000000::bigint AS at')).rows[0];

		expect(row.at).toBe(1_700_000_000_000);
	});

	describe('a connection that dies', () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		afterEach(() => errors.mockClear());

		it('does not crash the process while checked out and idle, and the pool recovers', async () => {
			const db = await testDb();
			const pool = db.$client;
			const held = await pool.connect();
			const { rows } = await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
			const crashed = vi.fn();
			process.once('uncaughtException', crashed);

			await adminPool().query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			held.release(true);

			expect(crashed).not.toHaveBeenCalled();
			process.removeListener('uncaughtException', crashed);
			expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
			expect(errors).toHaveBeenCalled();
		});

		it('logs an error on the pool instead of swallowing it', async () => {
			const db = await testDb();
			const pool = db.$client;
			const idle = await pool.connect();
			const { rows } = await idle.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
			idle.release();

			await adminPool().query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(errors.mock.calls.flat().join(' ')).toMatch(/database connection error/);
		});
	});

	it('keeps connections alive and bounds how long it waits for one', () => {
		const pool: pg.Pool = createPool(urlFor('sagas_unused_test'));

		expect(pool.options).toMatchObject({ keepAlive: true, connectionTimeoutMillis: 10_000 });
		void pool.end();
	});
});
