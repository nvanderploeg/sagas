import Database from 'better-sqlite3';
import type { BundleTable } from './tables.ts';

// The only module that opens SQLite: it reads the database inside a Bundle written by the last
// SQLite build, and nothing else.

export type Section = {
	name: string;
	columns: string[];
	rows: Iterable<unknown[]>;
};

export type LegacySource = {
	sections: Section[];
	eventSeq: number | null;
	close(): void;
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function openLegacy(file: string, tables: BundleTable[]): LegacySource {
	const sqlite = new Database(file, { readonly: true, fileMustExist: true });
	const present = new Set(
		(
			sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((row) => row.name)
	);
	const sections: Section[] = [];
	for (const { name } of tables) {
		if (!present.has(name)) continue;
		const columns = (
			sqlite.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]
		).map((column) => column.name);
		const statement = sqlite.prepare(`SELECT * FROM ${quote(name)}`).raw(true);
		sections.push({
			name,
			columns,
			// Opened when the import reaches the table: SQLite keeps a statement busy until it is drained.
			rows: { [Symbol.iterator]: () => statement.iterate() as Iterator<unknown[]> }
		});
	}
	const seq = present.has('sqlite_sequence')
		? (
				sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
					{ seq: number } | undefined
			)?.seq
		: undefined;
	return { sections, eventSeq: seq ?? null, close: () => sqlite.close() };
}

export function legacyIntegrity(file: string): string | null {
	const sqlite = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const result = sqlite.pragma('quick_check', { simple: true });
		return result === 'ok' ? null : String(result);
	} finally {
		sqlite.close();
	}
}

export function countLegacyRows(file: string, tables: string[]): Record<string, number> {
	const sqlite = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const present = new Set(
			(
				sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
					name: string;
				}[]
			).map((row) => row.name)
		);
		return Object.fromEntries(
			tables
				.filter((name) => present.has(name))
				.map((name) => [
					name,
					(sqlite.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n
				])
		);
	} finally {
		sqlite.close();
	}
}
