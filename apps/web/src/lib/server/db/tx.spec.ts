import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testDb } from '#lib/server/test/db.ts';
import { createPool, openDatabase, type Db } from './client.ts';
import { readSnapshot, transact } from './tx.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function counterDb() {
	const db = await testDb();
	await db.$client.query('CREATE TABLE ticks (id int PRIMARY KEY, n int NOT NULL)');
	await db.$client.query('INSERT INTO ticks VALUES (1, 0)');
	return db;
}

// Reads, waits, then writes back: any overlap of two of these loses an increment.
async function bump(db: Db): Promise<void> {
	await transact(db, async (tx) => {
		const { rows } = await tx.execute<{ n: number }>(sql`SELECT n FROM ticks WHERE id = 1`);
		await sleep(5);
		await tx.execute(sql`UPDATE ticks SET n = ${rows[0].n + 1} WHERE id = 1`);
	});
}

const total = async (db: Db) =>
	(await db.$client.query<{ n: number }>('SELECT n FROM ticks WHERE id = 1')).rows[0].n;

describe('transact', () => {
	it('serialises writers of different pools with the advisory lock', async () => {
		const db = await counterDb();
		const url = db.$client.options.connectionString!;
		const other = openDatabase(createPool(url, { max: 4 }));
		try {
			await Promise.all([
				...Array.from({ length: 8 }, () => bump(db)),
				...Array.from({ length: 8 }, () => bump(other))
			]);

			expect(await total(db)).toBe(16);
		} finally {
			await other.$client.end();
		}
	});

	it('queues writers of one pool without holding a connection each', async () => {
		const db = await counterDb();
		const small = openDatabase(
			createPool(db.$client.options.connectionString!, { max: 2, connectionTimeoutMillis: 1500 })
		);
		try {
			const writers = Array.from({ length: 6 }, () =>
				transact(small, async (tx) => {
					await tx.execute(sql`UPDATE ticks SET n = n + 1 WHERE id = 1`);
					// Needs a second connection while the transaction holds the first.
					await small.$client.query('SELECT 1');
				})
			);

			await Promise.all(writers);

			expect(await total(db)).toBe(6);
		} finally {
			await small.$client.end();
		}
	});

	it('joins the transaction it is given instead of waiting on its own writer', async () => {
		const db = await counterDb();

		await transact(db, (outer) =>
			transact(outer, async (inner) => {
				await inner.execute(sql`UPDATE ticks SET n = n + 1 WHERE id = 1`);
			})
		);

		expect(await total(db)).toBe(1);
	});

	it('rolls back a failed write and lets the next one run', async () => {
		const db = await counterDb();

		await expect(
			transact(db, async (tx) => {
				await tx.execute(sql`UPDATE ticks SET n = 99 WHERE id = 1`);
				throw new Error('nope');
			})
		).rejects.toThrow('nope');
		await bump(db);

		expect(await total(db)).toBe(1);
	});
});

describe('readSnapshot', () => {
	it('shows one state across reads while a write commits between them', async () => {
		const db = await counterDb();

		const seen = await readSnapshot(db, async (tx) => {
			const first = (await tx.execute<{ n: number }>(sql`SELECT n FROM ticks`)).rows[0].n;
			await bump(db);
			const second = (await tx.execute<{ n: number }>(sql`SELECT n FROM ticks`)).rows[0].n;
			return [first, second];
		});

		expect(seen).toEqual([0, 0]);
		expect(await total(db)).toBe(1);
	});
});
