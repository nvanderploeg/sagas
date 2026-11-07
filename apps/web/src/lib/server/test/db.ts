import { randomBytes } from 'node:crypto';
import { afterAll, expect, onTestFinished, vi } from 'vitest';
import pg from 'pg';
import { createPool, openDatabase, type Db } from '#lib/server/db/client.ts';

const live = new Map<string, pg.Pool>();
let admin: pg.Pool | undefined;

export function serverUrl(): URL {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	return new URL(url);
}

export function assertTestDatabase(name: string): void {
	if (!name.endsWith('_test')) {
		throw new Error(`refusing to touch "${name}": tests need a database named *_test`);
	}
}

export function adminPool(): pg.Pool {
	if (admin === undefined) {
		admin = new pg.Pool({ connectionString: serverUrl().toString(), max: 2 });
		admin.on('error', () => {});
	}
	return admin;
}

export function urlFor(name: string): string {
	const url = serverUrl();
	url.pathname = `/${name}`;
	return url.toString();
}

async function drop(name: string): Promise<void> {
	assertTestDatabase(name);
	const pool = live.get(name);
	live.delete(name);
	await pool?.end().catch(() => {});
	await adminPool().query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

let registered = false;

// A fresh, migrated database cloned from the template the global setup built. Dropped when the
// current test ends, or at the end of the file when called outside a test.
export async function testDb(): Promise<Db> {
	const template = process.env.SAGAS_TEST_TEMPLATE;
	if (!template) throw new Error('SAGAS_TEST_TEMPLATE is not set; run through vitest');
	if (!registered) {
		registered = true;
		afterAll(async () => {
			await Promise.all([...live.keys()].map(drop));
			await admin?.end().catch(() => {});
			admin = undefined;
		});
	}
	const name = `sagas_${randomBytes(6).toString('hex')}_test`;
	assertTestDatabase(name);
	await adminPool().query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
	const pool = createPool(urlFor(name), { max: 4, idleTimeoutMillis: 2_000 });
	live.set(name, pool);
	try {
		onTestFinished(() => drop(name));
	} catch {
		// Outside a test: afterAll drops it.
	}
	return openDatabase(pool);
}

// Statements the pool's clients send while `run` runs, session setup excluded.
export async function countStatements(run: () => unknown): Promise<number> {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	try {
		await run();
		return spy.mock.calls.filter(([first]) => {
			const text = typeof first === 'string' ? first : (first as { text?: string })?.text;
			return text !== undefined && !text.startsWith('SET idle_in_transaction');
		}).length;
	} finally {
		spy.mockRestore();
	}
}

// The database's own message behind a failed statement: drizzle's wrapper carries only the SQL.
export async function causeOf(statement: PromiseLike<unknown>): Promise<string> {
	try {
		await statement;
	} catch (error) {
		return (error as { cause?: Error }).cause?.message ?? (error as Error).message;
	}
	throw new Error('expected the statement to fail');
}

export async function expectFailure(
	statement: PromiseLike<unknown>,
	pattern: RegExp
): Promise<void> {
	expect(await causeOf(statement)).toMatch(pattern);
}

// The text of every statement the pool's clients send until `stop`, session setup excluded.
export function spyStatements() {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	return {
		texts: (): string[] =>
			spy.mock.calls.flatMap(([first]) => {
				const text = typeof first === 'string' ? first : (first as { text?: string })?.text;
				return text !== undefined && !text.startsWith('SET idle_in_transaction') ? [text] : [];
			}),
		stop: () => spy.mockRestore()
	};
}

export async function expectResolves(statement: PromiseLike<unknown>): Promise<void> {
	await expect(statement).resolves.not.toBeInstanceOf(Error);
}
