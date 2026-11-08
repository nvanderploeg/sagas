import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import Cursor from 'pg-cursor';
import type { Db } from '#lib/server/db/client.ts';
import {
	buildSchema,
	DATABASE_NAME,
	FORMAT,
	MANIFEST_NAME,
	SERVICE,
	type Manifest
} from './manifest.ts';
import { BUNDLE_TABLES, columnKind, quote, tableSql } from './tables.ts';
import { zipChunks, type ZipEntry } from './zip.ts';

const CURSOR_ROWS = 256;
const FLUSH_BYTES = 1 << 16;

export type ExportOptions = { appVersion?: string; now?: Date };

function selectExpression(name: string, kind: ReturnType<typeof columnKind>): string {
	const column = quote(name);
	if (kind === 'json') return `${column}::text`;
	if (kind === 'bytea') return `encode(${column}, 'base64')`;
	return column;
}

async function* dump(client: pg.PoolClient): AsyncGenerator<Buffer> {
	for (const { name, columns } of BUNDLE_TABLES) {
		yield Buffer.from(`${JSON.stringify({ table: name, columns: columns.map((c) => c.name) })}\n`);
		const select = columns.map((c) => selectExpression(c.name, columnKind(c))).join(', ');
		const cursor = client.query(
			new Cursor(`SELECT ${select} FROM ${tableSql(name)}`, [], { rowMode: 'array' })
		);
		let pending = '';
		for (;;) {
			const batch = await cursor.read(CURSOR_ROWS);
			if (batch.length === 0) break;
			for (const row of batch) pending += `${JSON.stringify(row)}\n`;
			if (pending.length > FLUSH_BYTES) {
				yield Buffer.from(pending);
				pending = '';
			}
		}
		await cursor.close();
		if (pending) yield Buffer.from(pending);
	}
}

// Every table is read inside one snapshot, so the Bundle is consistent however long it streams.
async function* entries(db: Db, now: Date, appVersion: string): AsyncGenerator<ZipEntry> {
	const client = await db.$client.connect();
	let clean = false;
	try {
		await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
		await client.query('SET LOCAL statement_timeout = 0');
		await client.query('SELECT pg_current_snapshot()');
		const hash = createHash('sha256');
		let size = 0;
		async function* body(): AsyncGenerator<Buffer> {
			for await (const chunk of dump(client)) {
				hash.update(chunk);
				size += chunk.length;
				yield chunk;
			}
		}
		yield { name: DATABASE_NAME, data: Readable.from(body()) };
		const manifest: Manifest = {
			format: FORMAT,
			service: SERVICE,
			appVersion,
			createdAt: now.toISOString(),
			schema: buildSchema(),
			files: [{ path: DATABASE_NAME, size, sha256: hash.digest('hex') }]
		};
		yield { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2)) };
		clean = true;
	} finally {
		if (clean) await client.query('ROLLBACK').catch(() => {});
		client.release(clean ? undefined : true);
	}
}

export function exportBundle(
	db: Db,
	options: ExportOptions = {}
): { stream: Readable; filename: string } {
	const now = options.now ?? new Date();
	const stream = Readable.from(
		zipChunks(entries(db, now, options.appVersion ?? __APP_VERSION__), now)
	);
	return { stream, filename: `sagas-export-${now.toISOString().slice(0, 10)}.zip` };
}
