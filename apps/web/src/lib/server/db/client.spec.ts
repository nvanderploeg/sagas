import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './client.ts';

describe('openDatabase', () => {
	let dir: string;
	let opened: Db[] = [];

	const open = (file: string): Db => {
		const db = openDatabase(file);
		opened.push(db);
		return db;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'sagas-db-'));
		opened = [];
	});

	afterEach(() => {
		for (const db of opened) db.$client.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('creates a missing parent directory and the database file', () => {
		const file = join(dir, 'nested', 'deeper', 'sagas.db');

		open(file);

		expect(existsSync(file)).toBe(true);
	});

	it('opens in WAL mode with foreign keys enforced', () => {
		const db = open(join(dir, 'sagas.db'));

		expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
	});

	it('applies every migration, and reopening the file applies none twice', () => {
		const file = join(dir, 'sagas.db');
		open(file).$client.close();

		const db = open(file);
		const tables = db.$client
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.pluck()
			.all();
		const applied = db.$client.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get();

		expect(tables).toEqual(
			expect.arrayContaining(['users', 'realms', 'states', 'substates', 'labours'])
		);
		expect(applied).toBe(4);
	});
});
