import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeVector } from '#lib/server/agent/vectors/vectors.ts';
import { appraise } from '#lib/server/agent/appraisals.ts';
import type { Db } from '#lib/server/db/client.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { createLabour } from '#lib/server/domain/labours.ts';
import { createScroll } from '#lib/server/domain/scrolls.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { keywordScores } from '#lib/server/agent/search.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { exportBundle } from './export.ts';
import { BusyError, importBundle, isRowError } from './import.ts';
import { BundleError, buildSchema, type Manifest } from './manifest.ts';
import { BUNDLE_TABLES, quote } from './tables.ts';
import { pipeEntry, readDirectory, zipChunks, type ZipEntry } from './zip.ts';

const LIMITS = { maxExpandedBytes: 1024 * 1024 * 1024 };

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sagas-bundle-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function writeZip(file: string, entries: ZipEntry[]): Promise<void> {
	await pipeline(Readable.from(zipChunks(entries)), createWriteStream(file));
}

async function exportTo(db: Db, file: string): Promise<void> {
	await pipeline(exportBundle(db).stream, createWriteStream(file));
}

function manifestFor(files: Record<string, Buffer>, patch: Partial<Manifest> = {}): ZipEntry {
	const manifest: Manifest = {
		format: 2,
		service: 'sagas',
		appVersion: 'test',
		createdAt: new Date().toISOString(),
		schema: buildSchema(),
		files: Object.entries(files).map(([path, data]) => ({
			path,
			size: data.length,
			sha256: sha(data)
		})),
		...patch
	};
	return { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) };
}

const lines = (...rows: unknown[]) =>
	Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));

async function bundleOf(name: string, database: Buffer, patch: Partial<Manifest> = {}) {
	const file = join(root, name);
	await writeZip(file, [
		{ name: 'db.ndjson', data: database },
		manifestFor({ 'db.ndjson': database }, patch)
	]);
	return file;
}

async function counts(db: Db): Promise<Record<string, number>> {
	const found: Record<string, number> = {};
	for (const { name } of BUNDLE_TABLES) {
		found[name] = (
			await db.$client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quote(name)}`)
		).rows[0].n;
	}
	return found;
}

async function populate(db: Db) {
	const actor = await seedActor(db);
	const realm = await seedRealm(db, 'AM');
	const first = await seedLabour(db, {
		realmId: realm.id,
		title: 'Telegraph the slam',
		description: 'wind-up'
	});
	const second = await seedLabour(db, { realmId: realm.id, title: 'Second' });
	await addComment(db, actor, first.id, 'a comment about wind-ups');
	await appraise(db, actor, [
		{ labourId: first.id, brief: 'Combat feel', links: [{ type: 'relates', to: second.id }] }
	]);
	await createScroll(db, actor, { realmId: realm.id, title: 'Release process', body: 'steps' });
	await writeVector(db, first.id, 'model', 'hash', new Float32Array(384).fill(0.5));
	return { actor, realm, first, second };
}

describe('export and import', () => {
	it('round-trips every table onto another database, vectors and ids included', async () => {
		const source = await testDb();
		const { first } = await populate(source);
		const bundle = join(root, 'out.zip');
		await exportTo(source, bundle);
		const target = await testDb();
		await populate(target);
		await seedLabour(target, { realmId: 1, title: 'to be replaced' });

		const result = await importBundle(target, bundle, LIMITS);

		expect(result.format).toBe(2);
		expect(await counts(target)).toEqual(await counts(source));
		const vector = (
			await target.$client.query<{ vector: Buffer }>(
				'SELECT vector FROM labour_vectors WHERE labour_id = $1',
				[first.id]
			)
		).rows[0].vector;
		expect(new Float32Array(vector.buffer, vector.byteOffset, 384)[7]).toBe(0.5);
		const keys = await target.$client.query<{ key: string }>(
			'SELECT key FROM labour_keys ORDER BY key'
		);
		expect(keys.rows.map((row) => row.key)).toEqual(['AM-1', 'AM-2']);
	});

	it('rebuilds the derived search tables, so imported text is found', async () => {
		const source = await testDb();
		const { first } = await populate(source);
		const bundle = join(root, 'out.zip');
		await exportTo(source, bundle);
		const target = await testDb();

		await importBundle(target, bundle, LIMITS);

		expect([...(await keywordScores(target, 'telegraph')).keys()]).toEqual([first.id]);
		expect([...(await keywordScores(target, 'wind-ups')).keys()]).toEqual([first.id]);
		const scrolls = await target.$client.query(
			"SELECT 1 FROM scroll_text WHERE search @@ plainto_tsquery('sagas_english', 'steps')"
		);
		expect(scrolls.rowCount).toBe(1);
	});

	it('continues every sequence above the imported ids, empty tables included', async () => {
		const source = await testDb();
		const { realm } = await populate(source);
		const bundle = join(root, 'out.zip');
		await exportTo(source, bundle);
		const target = await testDb();
		const actor = await seedActor(target);
		await seedRealm(target, 'ZZ');
		for (let i = 0; i < 7; i++) await seedLabour(target, { realmId: 1 });

		await importBundle(target, bundle, LIMITS);

		const made = await createLabour(target, actor, {
			realmId: realm.id,
			title: 'after import',
			ownerId: actor.id
		});
		expect(made.id).toBe(3);
		expect(made.key).toBe('AM-3');
		const window = await eventWindow(target);
		const top = (
			await target.$client.query<{ top: number }>('SELECT max(seq)::int AS top FROM events')
		).rows[0].top;
		expect(window.last).toBe(top);
		const next = await target.$client.query<{ id: number }>(
			`INSERT INTO skills (key, label, created_at, updated_at) VALUES ('first', 'First', 0, 0) RETURNING id`
		);
		expect(next.rows[0].id).toBe(1);
	});

	it('keeps the event counter at the exporting host seq after pruning emptied the log', async () => {
		const source = await testDb();
		await populate(source);
		const last = (await eventWindow(source)).last;
		await source.$client.query('DELETE FROM events');
		const bundle = join(root, 'out.zip');
		await exportTo(source, bundle);
		const target = await testDb();

		await importBundle(target, bundle, LIMITS);

		expect((await eventWindow(target)).last).toBe(last);
	});

	it('keeps the live event counter above the bundle when the instance is ahead of it', async () => {
		const source = await testDb();
		await populate(source);
		const bundle = join(root, 'out.zip');
		await exportTo(source, bundle);
		const bundleLast = (await eventWindow(source)).last;
		const target = await testDb();
		await populate(target);
		for (let i = 0; i < 5; i++) await seedLabour(target, { realmId: 1 });
		const liveLast = (await eventWindow(target)).last;
		expect(liveLast).toBeGreaterThan(bundleLast);

		await importBundle(target, bundle, LIMITS);

		expect((await eventWindow(target)).last).toBe(liveLast);
		const made = await createLabour(target, await seedActor(target), {
			realmId: 1,
			title: 'next',
			ownerId: 1
		});
		void made;
		expect((await eventWindow(target)).last).toBe(liveLast + 1);
	});

	it('exports a snapshot with a manifest listing the file with its checksum', async () => {
		const db = await testDb();
		await populate(db);
		const bundle = join(root, 'out.zip');
		await exportTo(db, bundle);

		const entries = await readDirectory(bundle);
		expect(entries.map((entry) => entry.name)).toEqual(['db.ndjson', 'manifest.json']);
		const read = async (name: string) => {
			const chunks: Buffer[] = [];
			await pipeEntry(
				bundle,
				entries.find((entry) => entry.name === name)!,
				new Writable({
					write(chunk, _e, cb) {
						chunks.push(chunk);
						cb();
					}
				})
			);
			return Buffer.concat(chunks);
		};
		const manifest = JSON.parse((await read('manifest.json')).toString()) as Manifest;
		const database = await read('db.ndjson');
		expect(manifest).toMatchObject({ format: 2, service: 'sagas', schema: buildSchema() });
		expect(manifest.files).toEqual([
			{ path: 'db.ndjson', size: database.length, sha256: sha(database) }
		]);
	});

	it('exports no derived table and no secret in the clear', async () => {
		const db = await testDb();
		await populate(db);
		const bundle = join(root, 'out.zip');
		await exportTo(db, bundle);
		const entry = (await readDirectory(bundle)).find((e) => e.name === 'db.ndjson')!;
		const chunks: Buffer[] = [];
		await pipeEntry(
			bundle,
			entry,
			new Writable({
				write(c, _e, cb) {
					chunks.push(c);
					cb();
				}
			})
		);
		const headers = Buffer.concat(chunks)
			.toString()
			.split('\n')
			.filter((line) => line.startsWith('{"table"'))
			.map((line) => JSON.parse(line).table);

		expect(headers).not.toContain('labour_text');
		expect(headers).not.toContain('scroll_text');
		expect(headers).toContain('event_counter');
	});

	it('hands every pooled connection back, also when the client goes away mid-stream', async () => {
		const db = await testDb();
		await populate(db);
		const { stream } = exportBundle(db);

		const reader = stream[Symbol.asyncIterator]();
		await reader.next();
		await reader.return?.();
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(db.$client.totalCount - db.$client.idleCount).toBe(0);
	});
});

describe('refusals', () => {
	let target: Db;

	beforeEach(async () => {
		target = await testDb();
		await populate(target);
	});

	const untouched = async () => {
		const before = await counts(target);
		return async () => expect(await counts(target)).toEqual(before);
	};

	const refused = async (bundle: string, message: RegExp) => {
		const same = await untouched();
		const error = await importBundle(target, bundle, LIMITS).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BundleError);
		expect((error as Error).message).toMatch(message);
		await same();
	};

	const header = (table: string, columns: string[]) => ({ table, columns });

	it('refuses a bundle whose bytes were damaged', async () => {
		const bundle = join(root, 'out.zip');
		await exportTo(target, bundle);
		const bytes = readFileSync(bundle);
		bytes[Math.floor(bytes.length / 4)] ^= 0xff;
		writeFileSync(bundle, bytes);

		await expect(importBundle(target, bundle, LIMITS)).rejects.toThrow(BundleError);
	});

	it('refuses a checksum mismatch at equal size', async () => {
		const data = lines(header('skills', ['id']));
		const bundle = join(root, 'tamper.zip');
		await writeZip(bundle, [
			{ name: 'db.ndjson', data },
			manifestFor({ 'db.ndjson': Buffer.from(data.toString().replace('id', 'ix')) })
		]);

		await refused(bundle, /fails its checksum/);
	});

	it('refuses a bundle from a newer schema than this build', async () => {
		const bundle = await bundleOf('newer.zip', lines(), {
			schema: { level: buildSchema().level + 1, latest: buildSchema().latest }
		});

		await refused(bundle, /newer than this build/);
	});

	it('refuses a manifest from a newer format and one from another service', async () => {
		await refused(await bundleOf('f.zip', lines(), { format: 3 }), /format 3/);
		await refused(await bundleOf('s.zip', lines(), { service: 'chronicle' }), /made by chronicle/);
	});

	it('refuses a bundle with no manifest and a file that is not a zip', async () => {
		const bare = join(root, 'bare.zip');
		await writeZip(bare, [{ name: 'db.ndjson', data: lines() }]);
		await refused(bare, /no manifest/);
		const junk = join(root, 'junk.zip');
		writeFileSync(junk, Buffer.alloc(100, 1));
		await refused(junk, /Not a valid zip/);
	});

	it('refuses a bundle that unpacks past the limit', async () => {
		const bundle = await bundleOf('big.zip', lines({ table: 'skills', columns: ['id'] }));
		const same = await untouched();
		await expect(importBundle(target, bundle, { maxExpandedBytes: 1 })).rejects.toThrow(
			/import limit/
		);
		await same();
	});

	it('refuses a file in the bundle that the manifest does not list', async () => {
		const data = lines();
		const bundle = join(root, 'extra.zip');
		await writeZip(bundle, [
			{ name: 'db.ndjson', data },
			{ name: 'extra.txt', data: Buffer.from('x') },
			manifestFor({ 'db.ndjson': data })
		]);

		await refused(bundle, /not in the manifest/);
	});

	describe('zip-slip', () => {
		for (const name of ['../escape.txt', '/etc/escape.txt', 'a//x', './x', 'a\\..\\x']) {
			it(`refuses ${JSON.stringify(name)}`, async () => {
				const data = lines();
				const payload = Buffer.from('pwned');
				const bundle = join(root, 'slip.zip');
				await writeZip(bundle, [
					{ name: 'db.ndjson', data },
					{ name, data: payload },
					manifestFor({ 'db.ndjson': data, [name]: payload })
				]);

				await refused(bundle, /Unsafe|nothing else/);
			});
		}
	});

	it('refuses an unknown table, a short row and a missing required column', async () => {
		await refused(
			await bundleOf('a.zip', lines(header('nope', ['id']), [1])),
			/unknown table nope/
		);
		await refused(
			await bundleOf('b.zip', lines(header('realms', ['id', 'name', 'key']), [1, 'only a name'])),
			/does not match its table header/
		);
		await refused(
			await bundleOf('c.zip', lines(header('realms', ['id', 'name']), [1, 'No key'])),
			/realms\.key is missing/
		);
	});

	it('answers a row the database rejects as the bundle fault and rolls everything back', async () => {
		const bad = lines(
			header('realms', ['id', 'name', 'key', 'labour_counter']),
			[1, 'Amber', 'AM', 0],
			[2, 'Lower', 'lower', 0]
		);

		await refused(await bundleOf('check.zip', bad), /realms_key_format/);
	});

	it('refuses text that PostgreSQL cannot store', async () => {
		const bad = lines(header('realms', ['id', 'name', 'key', 'labour_counter']), [
			1,
			'A\u0000B',
			'AM',
			0
		]);

		await refused(await bundleOf('nul.zip', bad), /U\+0000/);
	});

	it('refuses a row that points at nothing, when the transaction commits', async () => {
		const bad = lines(header('labour_keys', ['key', 'labour_id', 'created_at']), ['AM-1', 99, 0]);

		await refused(await bundleOf('fk.zip', bad), /foreign key/);
	});

	it('runs one import at a time', async () => {
		const bundle = join(root, 'out.zip');
		await exportTo(target, bundle);

		const results = await Promise.allSettled([
			importBundle(target, bundle, LIMITS),
			importBundle(target, bundle, LIMITS)
		]);

		expect(results.map((r) => (r.status === 'rejected' ? r.reason.constructor : 'ok'))).toContain(
			BusyError
		);
		expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
	});
});

describe('isRowError', () => {
	it.each([
		['22021', true],
		['22P02', true],
		['23505', true],
		['23503', true],
		['23514', true],
		['08006', false],
		['40001', false],
		['57014', false],
		['53300', false]
	])('reads SQLSTATE %s as %s', (code, blamesBundle) => {
		expect(isRowError(Object.assign(new Error('x'), { code }))).toBe(blamesBundle);
	});

	it('ignores errors without a code', () => {
		expect(isRowError(new Error('x'))).toBe(false);
		expect(isRowError(null)).toBe(false);
	});
});

describe('archive format', () => {
	const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

	it.skipIf(!hasUnzip)('is a zip that standard tools read', async () => {
		const db = await testDb();
		await populate(db);
		const bundle = join(root, 'out.zip');
		await exportTo(db, bundle);

		const result = spawnSync('unzip', ['-t', bundle], { encoding: 'utf8' });
		expect(result.stdout).toContain('No errors detected');
		const listing = spawnSync('unzip', ['-Z1', bundle], { encoding: 'utf8' }).stdout.split('\n');
		expect(listing).toEqual(['db.ndjson', 'manifest.json', '']);
	});
});
