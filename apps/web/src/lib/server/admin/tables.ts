import { is } from 'drizzle-orm';
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import * as schema from '#lib/server/db/schema.ts';
import { TABLE_PREFIX } from '#lib/server/db/schema.ts';

// Rebuilt from the tables below on import, never carried in a Bundle.
export const DERIVED_TABLES = ['labour_text', 'scroll_text'];

export type BundleTable = { name: string; table: PgTable; columns: PgColumn[] };

function tablesOf(): BundleTable[] {
	const found: BundleTable[] = [];
	for (const value of Object.values(schema)) {
		if (!is(value, PgTable)) continue;
		const config = getTableConfig(value);
		const name = config.name.slice(TABLE_PREFIX.length);
		if (DERIVED_TABLES.includes(name)) continue;
		found.push({ name, table: value, columns: config.columns });
	}
	return found;
}

// Parents first where the foreign keys allow it; cycles break at the first table met.
function ordered(tables: BundleTable[]): BundleTable[] {
	const byTable = new Map(tables.map((entry) => [entry.table as unknown, entry]));
	const done = new Set<BundleTable>();
	const visiting = new Set<BundleTable>();
	const result: BundleTable[] = [];
	const visit = (entry: BundleTable) => {
		if (done.has(entry) || visiting.has(entry)) return;
		visiting.add(entry);
		for (const fk of getTableConfig(entry.table).foreignKeys) {
			const parent = byTable.get(fk.reference().foreignTable);
			if (parent && parent !== entry) visit(parent);
		}
		visiting.delete(entry);
		done.add(entry);
		result.push(entry);
	};
	for (const entry of [...tables].sort((a, b) => (a.name < b.name ? -1 : 1))) visit(entry);
	return result;
}

export const BUNDLE_TABLES: BundleTable[] = ordered(tablesOf());

export function columnKind(column: PgColumn): 'json' | 'bytea' | 'boolean' | 'plain' {
	switch (column.getSQLType()) {
		case 'json':
		case 'jsonb':
			return 'json';
		case 'bytea':
			return 'bytea';
		case 'boolean':
			return 'boolean';
		default:
			return 'plain';
	}
}

export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

// Bundle and stats names are unprefixed; SQL takes the physical name.
export const tableSql = (name: string) => quote(TABLE_PREFIX + name);
