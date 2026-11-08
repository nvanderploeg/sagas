import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from '#lib/server/db/schema.ts';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { WRITER_LOCK } from '#lib/server/db/tx.ts';
import { rebuildLabourText } from '#lib/server/agent/derived.ts';
import { endEventStreams } from '#lib/server/events/stream.ts';
import {
	BundleError,
	buildSchema,
	DATABASE_NAME,
	FORMAT,
	LEGACY_DATABASE_NAME,
	LEGACY_FORMAT,
	LEGACY_LEVEL,
	MANIFEST_NAME,
	MAX_MANIFEST_BYTES,
	parseManifest,
	SERVICE,
	type Manifest
} from './manifest.ts';
import { legacyIntegrity, openLegacy, type Section } from './legacy.ts';
import {
	BUNDLE_TABLES,
	columnKind,
	DERIVED_TABLES,
	quote,
	tableSql,
	type BundleTable
} from './tables.ts';
import { pipeEntry, readDirectory, safeRelativePath, ZipError, type ZipFileEntry } from './zip.ts';

export class BusyError extends Error {}

export type ImportOptions = {
	// Largest the Bundle may unpack to.
	maxExpandedBytes: number;
};

export type ImportResult = {
	format: number;
	appVersion: string;
	createdAt: string;
	rows: Record<string, number>;
	ignoredFiles: number;
};

type Rows = Record<string, number>;
type Insert = (section: Section) => Promise<void>;
type Loaded = { eventSeq: number | null };

const BATCH_ROWS = 500;
const PARAMETER_BUDGET = 60_000;
const MAX_LINE_BYTES = 40 << 20;

let busy = false;

// Only SQLSTATE classes 22 (data exception) and 23 (integrity violation) blame the Bundle.
export function isRowError(error: unknown): error is Error & { code: string } {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && /^2[23]/.test(code);
}

export async function importBundle(
	db: Db,
	zipFile: string,
	options: ImportOptions
): Promise<ImportResult> {
	if (busy) throw new BusyError('Another import is running');
	busy = true;
	const scratch = await mkdtemp(join(tmpdir(), 'sagas-import-'));
	try {
		return await run(db, zipFile, scratch, options);
	} catch (error) {
		if (error instanceof ZipError) throw new BundleError(error.message);
		if (error instanceof SyntaxError) throw new BundleError('db.ndjson is not valid');
		if (isRowError(error)) throw new BundleError(error.message);
		if (/^Z_/.test(String((error as { code?: unknown } | null)?.code))) {
			throw new BundleError(`The bundle is damaged: ${(error as Error).message}`);
		}
		throw error;
	} finally {
		busy = false;
		await rm(scratch, { recursive: true, force: true });
	}
}

async function readText(zipFile: string, entry: ZipFileEntry, limit: number): Promise<string> {
	const parts: Buffer[] = [];
	let total = 0;
	await pipeEntry(
		zipFile,
		entry,
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				total += chunk.length;
				if (total > limit) return callback(new BundleError(`${entry.name} is too large`));
				parts.push(chunk);
				callback();
			}
		})
	);
	return Buffer.concat(parts).toString('utf8');
}

async function verify(zipFile: string, entry: ZipFileEntry, expected: string): Promise<void> {
	const digest = await pipeEntry(
		zipFile,
		entry,
		new Writable({ write: (_chunk, _encoding, callback) => callback() })
	);
	if (digest !== expected) throw new BundleError(`${entry.name} fails its checksum`);
}

function checkSchema(manifest: Manifest, legacy: boolean): void {
	const build = buildSchema();
	const newer = legacy
		? manifest.schema.level > LEGACY_LEVEL
		: manifest.schema.level > build.level || manifest.schema.latest > build.latest;
	if (newer) {
		throw new BundleError(
			`The bundle's schema (${manifest.schema.level} migrations) is newer than this build. Upgrade this server first.`
		);
	}
}

function summary(manifest: Manifest, rows: Rows, ignoredFiles: number): ImportResult {
	return {
		format: manifest.format,
		appVersion: manifest.appVersion,
		createdAt: manifest.createdAt,
		rows,
		ignoredFiles
	};
}

async function run(
	db: Db,
	zipFile: string,
	scratch: string,
	options: ImportOptions
): Promise<ImportResult> {
	const byName = new Map<string, ZipFileEntry>();
	for (const entry of await readDirectory(zipFile)) {
		if (entry.name.endsWith('/') && entry.size === 0) continue;
		if (byName.has(entry.name)) throw new BundleError(`The bundle repeats ${entry.name}`);
		byName.set(entry.name, entry);
	}
	const manifestEntry = byName.get(MANIFEST_NAME);
	if (!manifestEntry) throw new BundleError('The bundle has no manifest.json');
	const manifest = parseManifest(await readText(zipFile, manifestEntry, MAX_MANIFEST_BYTES));

	const legacy = manifest.format === LEGACY_FORMAT;
	if (!legacy && manifest.format !== FORMAT) {
		throw new BundleError(`The bundle has format ${manifest.format}, which this build cannot read`);
	}
	if (!legacy && manifest.service !== SERVICE) {
		throw new BundleError(`The bundle was made by ${manifest.service ?? 'another service'}`);
	}
	checkSchema(manifest, legacy);

	const listed = new Map<string, Manifest['files'][number]>();
	for (const file of manifest.files) {
		if (!safeRelativePath(file.path)) throw new BundleError(`Unsafe path ${file.path}`);
		if (listed.has(file.path)) throw new BundleError(`The manifest repeats ${file.path}`);
		listed.set(file.path, file);
	}
	const main = legacy ? LEGACY_DATABASE_NAME : DATABASE_NAME;
	if (!listed.has(main)) throw new BundleError('The bundle has no database');
	for (const name of byName.keys()) {
		if (name !== MANIFEST_NAME && !listed.has(name)) {
			throw new BundleError(`${name} is in the bundle but not in the manifest`);
		}
	}
	let total = 0;
	for (const file of listed.values()) {
		const entry = byName.get(file.path);
		if (!entry) throw new BundleError(`${file.path} is in the manifest but not in the bundle`);
		if (entry.size !== file.size) throw new BundleError(`${file.path} differs from its manifest`);
		total += file.size;
	}
	if (!legacy && listed.size !== 1) {
		throw new BundleError(`A bundle holds ${DATABASE_NAME} and nothing else`);
	}
	if (total > options.maxExpandedBytes) {
		throw new BundleError('The bundle unpacks to more than the import limit allows');
	}

	const dbEntry = byName.get(main)!;
	const expected = listed.get(main)!.sha256;
	const ignoredFiles = listed.size - 1;
	if (legacy) return importLegacy(db, zipFile, dbEntry, expected, scratch, manifest, ignoredFiles);

	await verify(zipFile, dbEntry, expected);
	const rows = await load(db, false, async (insert) => {
		await replay(zipFile, dbEntry, insert);
		return { eventSeq: null };
	});
	endEventStreams();
	return summary(manifest, rows, ignoredFiles);
}

async function importLegacy(
	db: Db,
	zipFile: string,
	entry: ZipFileEntry,
	expected: string,
	scratch: string,
	manifest: Manifest,
	ignoredFiles: number
): Promise<ImportResult> {
	const file = join(scratch, 'legacy.db');
	const digest = await pipeEntry(zipFile, entry, createWriteStream(file, { mode: 0o600 }));
	if (digest !== expected) throw new BundleError(`${entry.name} fails its checksum`);
	let problem: string | null;
	try {
		problem = legacyIntegrity(file);
	} catch {
		throw new BundleError('The bundle holds no readable SQLite database');
	}
	if (problem !== null) throw new BundleError(`The bundle's database is damaged: ${problem}`);

	const source = openLegacy(file, BUNDLE_TABLES);
	try {
		const rows = await load(db, true, async (insert) => {
			for (const section of source.sections) await insert(section);
			return { eventSeq: source.eventSeq };
		});
		endEventStreams();
		return summary(manifest, rows, ignoredFiles);
	} finally {
		source.close();
	}
}

async function* lines(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
	let rest: Buffer = Buffer.alloc(0);
	for await (const chunk of source) {
		rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
		let at: number;
		while ((at = rest.indexOf(10)) >= 0) {
			yield rest.toString('utf8', 0, at);
			rest = rest.subarray(at + 1);
		}
		if (rest.length > MAX_LINE_BYTES) throw new BundleError('A database line is absurdly long');
	}
	if (rest.length) yield rest.toString('utf8');
}

async function replay(zipFile: string, entry: ZipFileEntry, insert: Insert): Promise<void> {
	const pass = new PassThrough();
	const done = pipeEntry(zipFile, entry, pass);
	done.catch(() => {});
	try {
		const pending: unknown[][] = [];
		let header: { name: string; columns: string[] } | undefined;
		const drain = async () => {
			if (header && pending.length) {
				await insert({ name: header.name, columns: header.columns, rows: pending.splice(0) });
			}
		};
		for await (const line of lines(pass)) {
			if (line === '') continue;
			const parsed: unknown = JSON.parse(line);
			if (Array.isArray(parsed)) {
				if (!header || parsed.length !== header.columns.length) {
					throw new BundleError('A row does not match its table header');
				}
				pending.push(parsed);
				if (pending.length >= BATCH_ROWS) await drain();
				continue;
			}
			await drain();
			const given = parsed as { table?: unknown; columns?: unknown };
			if (typeof given.table !== 'string' || !Array.isArray(given.columns)) {
				throw new BundleError('db.ndjson holds a line that is neither a header nor a row');
			}
			header = { name: given.table, columns: given.columns.map(String) };
		}
		await drain();
		await done;
	} finally {
		pass.destroy();
	}
}

function convert(table: BundleTable, name: string, legacy: boolean): (value: unknown) => unknown {
	const column = table.columns.find((entry) => entry.name === name)!;
	switch (columnKind(column)) {
		case 'boolean':
			return (value) => (value === null ? null : Boolean(value));
		case 'bytea':
			return (value) =>
				value === null || Buffer.isBuffer(value) || legacy
					? value
					: Buffer.from(String(value), 'base64');
		default:
			return (value) => value;
	}
}

// Replace-everything, in one transaction: either the whole Bundle lands or the database is
// untouched. The writer lock and TRUNCATE hold every other statement until the commit.
async function load(
	db: Db,
	legacy: boolean,
	fill: (insert: Insert) => Promise<Loaded>
): Promise<Rows> {
	const client = await db.$client.connect();
	const counts: Rows = {};
	let clean = false;
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL statement_timeout = 0');
		await client.query('SELECT pg_advisory_xact_lock($1)', [WRITER_LOCK]);
		await client.query('SET CONSTRAINTS ALL DEFERRED');
		const live = await client.query<{ last: number }>('SELECT last FROM sagas_event_counter');
		const liveSeq = live.rows[0]?.last ?? 0;
		const everything = [...BUNDLE_TABLES.map((entry) => entry.name), ...DERIVED_TABLES];
		await client.query(`TRUNCATE ${everything.map(tableSql).join(', ')}`);

		const seen = new Set<string>();
		const insert: Insert = async (section) => {
			const table = BUNDLE_TABLES.find((entry) => entry.name === section.name);
			if (!table) throw new BundleError(`The bundle has an unknown table ${section.name}`);
			if (!seen.has(section.name)) {
				seen.add(section.name);
				const given = new Set(section.columns);
				for (const column of table.columns) {
					if (!given.has(column.name) && column.notNull && !column.hasDefault) {
						throw new BundleError(`${section.name}.${column.name} is missing and has no default`);
					}
				}
			}
			const known = new Set(table.columns.map((column) => column.name));
			const picks = section.columns.flatMap((name, index) =>
				known.has(name) ? [{ name, index, convert: convert(table, name, legacy) }] : []
			);
			if (picks.length === 0) return;
			const per = Math.max(1, Math.min(BATCH_ROWS, Math.floor(PARAMETER_BUDGET / picks.length)));
			const names = picks.map((pick) => quote(pick.name)).join(', ');
			let batch: unknown[][] = [];
			const flush = async () => {
				if (batch.length === 0) return;
				const placeholders = batch
					.map((_, r) => `(${picks.map((_, c) => `$${r * picks.length + c + 1}`).join(', ')})`)
					.join(', ');
				for (const row of batch) {
					if (row.some((value) => typeof value === 'string' && value.includes('\0'))) {
						throw new BundleError(
							`${section.name} holds U+0000, which PostgreSQL text cannot store`
						);
					}
				}
				await client.query(
					`INSERT INTO ${tableSql(section.name)} (${names}) VALUES ${placeholders}`,
					batch.flat()
				);
				counts[section.name] = (counts[section.name] ?? 0) + batch.length;
				batch = [];
			};
			for (const row of section.rows) {
				batch.push(picks.map((pick) => pick.convert(row[pick.index] ?? null)));
				if (batch.length >= per) await flush();
			}
			await flush();
		};

		const { eventSeq } = await fill(insert);
		await rebuildDerived(client);
		await resetSequences(client, Math.max(eventSeq ?? 0, liveSeq));
		await client.query('COMMIT');
		clean = true;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		client.release(clean ? undefined : true);
	}
	return counts;
}

async function rebuildDerived(client: pg.PoolClient): Promise<void> {
	await client.query(
		'INSERT INTO sagas_scroll_text (scroll_id, title, body) SELECT id, title, body FROM sagas_scrolls'
	);
	await rebuildLabourText(drizzle(client, { schema }) as unknown as Handle);
}

// Imported rows carry their own ids: every sequence must continue above them, empty tables
// included. The event counter never falls below the seq this instance already handed out.
async function resetSequences(client: pg.PoolClient, eventSeq: number): Promise<void> {
	const identities = await client.query<{ table_name: string; column_name: string }>(
		`SELECT table_name, column_name FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name LIKE 'sagas\\_%' AND is_identity = 'YES'`
	);
	for (const { table_name, column_name } of identities.rows) {
		const table = quote(table_name);
		const column = quote(column_name);
		await client.query(
			`SELECT setval(pg_get_serial_sequence($1, $2),
				COALESCE((SELECT max(${column}) FROM ${table}), 1),
				(SELECT max(${column}) FROM ${table}) IS NOT NULL)`,
			[`public.${table}`, column_name]
		);
	}
	await client.query(
		`INSERT INTO sagas_event_counter (id, last)
		 VALUES (1, GREATEST($1::int, COALESCE((SELECT max(seq) FROM sagas_events), 0)))
		 ON CONFLICT (id) DO UPDATE
		 SET last = GREATEST(sagas_event_counter.last, EXCLUDED.last)`,
		[eventSeq]
	);
}
