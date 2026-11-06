import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeVector } from '#lib/server/agent/vectors/vectors.ts';
import { openDatabase, type Db } from '#lib/server/db/client.ts';
import { labours } from '#lib/server/db/schema.ts';
import { seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { applyPendingImport } from './apply.ts';
import { exportBundle, type ExportOptions } from './export.ts';
import { stageImport, readPendingImport, discardPendingImport } from './import.ts';
import type { DataLayout } from './layout.ts';
import { BundleError, buildSchema, type Manifest } from './manifest.ts';
import { pipeEntry, readDirectory, zipChunks, type ZipEntry } from './zip.ts';

const LIMITS = { maxExpandedBytes: 1024 * 1024 * 1024 };

let root: string;
const opened: Db[] = [];

function layoutAt(name: string): DataLayout {
	const dataDir = join(root, name);
	mkdirSync(dataDir, { recursive: true });
	return {
		dataDir,
		databaseFile: join(dataDir, 'sagas.db'),
		attachmentsDir: join(dataDir, 'attachments')
	};
}

function open(layout: DataLayout): Db {
	const db = openDatabase(layout.databaseFile);
	opened.push(db);
	return db;
}

function putAttachment(layout: DataLayout, path: string, content: string): void {
	const file = join(layout.attachmentsDir, path);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, content);
}

async function writeZip(file: string, entries: ZipEntry[]): Promise<void> {
	await pipeline(Readable.from(zipChunks(entries)), createWriteStream(file));
}

async function exportTo(
	db: Db,
	layout: DataLayout,
	file: string,
	options: ExportOptions = {}
): Promise<void> {
	const { stream } = await exportBundle(db, layout, options);
	await pipeline(stream, createWriteStream(file));
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function manifestFor(files: Record<string, Buffer>, patch: Partial<Manifest> = {}): ZipEntry {
	const schema = buildSchema();
	const manifest: Manifest = {
		format: 1,
		appVersion: 'test',
		createdAt: new Date().toISOString(),
		schema,
		files: Object.entries(files).map(([path, data]) => ({
			path,
			size: data.length,
			sha256: sha(data)
		})),
		skipped: [],
		remoteAttachments: [],
		...patch
	};
	return { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) };
}

function snapshotOf(db: Db, name: string): Buffer {
	const file = join(root, name);
	db.$client.prepare('VACUUM INTO ?').run(file);
	return readFileSync(file);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sagas-bundle-'));
});

afterEach(() => {
	for (const db of opened.splice(0)) if (db.$client.open) db.$client.close();
	rmSync(root, { recursive: true, force: true });
});

describe('export and import', () => {
	it('round-trips rows, vectors and attachments onto another host, backing up what it replaces', async () => {
		const source = layoutAt('source');
		const db = open(source);
		const realm = seedRealm(db);
		const labour = seedLabour(db, { realmId: realm.id, title: 'Carry me over' });
		writeVector(db, labour.id, 'model-x', 'hash-1', Float32Array.from([0.25, -1.5, 3]));
		putAttachment(source, 'ab/cd/photo.bin', 'photo bytes');
		putAttachment(source, 'note.txt', 'hello');
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle);

		const target = layoutAt('target');
		const old = open(target);
		seedRealm(old, 'OLD');
		putAttachment(target, 'stale.txt', 'stale');
		old.$client.close();

		const pending = await stageImport(bundle, target, LIMITS);
		expect(pending.files).toBe(3);
		expect(await readPendingImport(target)).toMatchObject({ files: 3 });
		expect(applyPendingImport(target)).toContain('pre-import-');

		const restored = open(target);
		expect(
			restored
				.select()
				.from(labours)
				.all()
				.map((l) => l.title)
		).toEqual(['Carry me over']);
		const row = restored.$client
			.prepare('SELECT vector, model, input_hash FROM labour_vectors')
			.get() as { vector: Buffer; model: string; input_hash: string };
		expect(new Float32Array(row.vector.buffer, row.vector.byteOffset, 3)).toEqual(
			Float32Array.from([0.25, -1.5, 3])
		);
		expect(row.model).toBe('model-x');
		expect(readFileSync(join(target.attachmentsDir, 'ab/cd/photo.bin'), 'utf8')).toBe(
			'photo bytes'
		);
		expect(existsSync(join(target.attachmentsDir, 'stale.txt'))).toBe(false);
		expect(existsSync(join(target.dataDir, 'import-pending'))).toBe(false);

		const [backup] = readdirSync(join(target.dataDir, 'backups'));
		const backedUp = openDatabase(join(target.dataDir, 'backups', backup, 'sagas.db'));
		opened.push(backedUp);
		expect(backedUp.$client.prepare('SELECT key FROM realms').all()).toEqual([{ key: 'OLD' }]);
		expect(
			readFileSync(join(target.dataDir, 'backups', backup, 'attachments/stale.txt'), 'utf8')
		).toBe('stale');
	});

	it('exports a snapshot with a manifest listing every file with its checksum', async () => {
		const source = layoutAt('source');
		const db = open(source);
		putAttachment(source, 'a.txt', 'abc');
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle);

		const target = layoutAt('target');
		await stageImport(bundle, target, LIMITS);
		const staged = join(target.dataDir, 'import-pending', 'attachments', 'a.txt');
		expect(readFileSync(staged, 'utf8')).toBe('abc');
		expect(readdirSync(source.dataDir).filter((n) => n.startsWith('export-tmp-'))).toEqual([]);
	});

	it('migrates a bundle from an older schema before it is swapped in', async () => {
		const db = open(layoutAt('source'));
		db.$client.exec(
			'DROP INDEX labours_recurrence_idx; ALTER TABLE labours DROP COLUMN recurrence_id; DROP TABLE recurrence_quests; DROP TABLE recurrences;'
		);
		db.$client.exec(
			'DELETE FROM __drizzle_migrations WHERE rowid = (SELECT max(rowid) FROM __drizzle_migrations)'
		);
		const { hash: _hash, ...latest } = db.$client
			.prepare(
				'SELECT hash, max(created_at) AS latest, count(*) AS level FROM __drizzle_migrations'
			)
			.get() as { hash: string; latest: number; level: number };
		const data = snapshotOf(db, 'older.db');
		const bundle = join(root, 'older.zip');
		await writeZip(bundle, [
			{ name: 'db/sagas.db', data },
			manifestFor({ 'db/sagas.db': data }, { schema: latest })
		]);
		const target = layoutAt('target');
		const pending = await stageImport(bundle, target, LIMITS);
		expect(pending.bundleSchema.level).toBe(buildSchema().level - 1);

		applyPendingImport(target);
		const migrated = open(target);
		expect(migrated.$client.prepare('SELECT count(*) AS n FROM recurrences').get()).toEqual({
			n: 0
		});
		expect(
			migrated.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()
		).toEqual({
			n: buildSchema().level
		});
	});

	it('discards a staged import', async () => {
		const source = layoutAt('source');
		const db = open(source);
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle);
		const target = layoutAt('target');
		await stageImport(bundle, target, LIMITS);
		await discardPendingImport(target);
		expect(await readPendingImport(target)).toBeNull();
		expect(applyPendingImport(target)).toBeNull();
	});
});

describe('refusals', () => {
	let source: DataLayout;
	let db: Db;
	let target: DataLayout;

	beforeEach(() => {
		source = layoutAt('source');
		db = open(source);
		target = layoutAt('target');
	});

	const refused = async (bundle: string, message: RegExp) => {
		await expect(stageImport(bundle, target, LIMITS)).rejects.toThrow(message);
		expect(readdirSync(target.dataDir).filter((n) => n.startsWith('import-'))).toEqual([]);
	};

	it('refuses an attachment whose bytes differ from the manifest checksum', async () => {
		const data = snapshotOf(db, 'one.db');
		const file = Buffer.from('real');
		const bundle = join(root, 'tamper.zip');
		await writeZip(bundle, [
			{ name: 'db/sagas.db', data },
			{ name: 'attachments/a.txt', data: file },
			manifestFor({ 'db/sagas.db': data, 'attachments/a.txt': Buffer.from('forged') })
		]);
		await refused(bundle, /differs from its manifest|fails its checksum/);
	});

	it('refuses a checksum mismatch at equal size', async () => {
		const data = snapshotOf(db, 'one.db');
		const bundle = join(root, 'tamper.zip');
		await writeZip(bundle, [
			{ name: 'db/sagas.db', data },
			{ name: 'attachments/a.txt', data: Buffer.from('real') },
			manifestFor({ 'db/sagas.db': data, 'attachments/a.txt': Buffer.from('fake') })
		]);
		await refused(bundle, /fails its checksum/);
	});

	it('refuses a bundle whose bytes were damaged', async () => {
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle);
		const bytes = readFileSync(bundle);
		bytes[Math.floor(bytes.length / 4)] ^= 0xff;
		writeFileSync(bundle, bytes);
		await expect(stageImport(bundle, target, LIMITS)).rejects.toThrow(BundleError);
	});

	it('refuses a bundle from a newer schema than this build', async () => {
		const data = snapshotOf(db, 'one.db');
		const now = buildSchema();
		const bundle = join(root, 'newer.zip');
		await writeZip(bundle, [
			{ name: 'db/sagas.db', data },
			manifestFor(
				{ 'db/sagas.db': data },
				{ schema: { level: now.level + 1, latest: now.latest + 1 } }
			)
		]);
		await refused(bundle, /newer than this build/);
	});

	it('refuses a database carrying a migration this build lacks', async () => {
		db.$client
			.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
			.run('f'.repeat(64), Date.now());
		const data = snapshotOf(db, 'future.db');
		const bundle = join(root, 'future.zip');
		await writeZip(bundle, [{ name: 'db/sagas.db', data }, manifestFor({ 'db/sagas.db': data })]);
		await refused(bundle, /newer than this build/);
	});

	it('refuses a manifest from a newer format', async () => {
		const bundle = join(root, 'format.zip');
		await writeZip(bundle, [
			{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 99 })) }
		]);
		await refused(bundle, /newer than this build reads/);
	});

	it('refuses a bundle with no manifest', async () => {
		const bundle = join(root, 'bare.zip');
		await writeZip(bundle, [{ name: 'db/sagas.db', data: Buffer.from('x') }]);
		await refused(bundle, /no manifest/);
	});

	it('refuses a file that is not a zip', async () => {
		const bundle = join(root, 'junk.zip');
		writeFileSync(bundle, Buffer.alloc(200, 7));
		await refused(bundle, /Not a valid zip/);
	});

	it('refuses a database that is not SQLite', async () => {
		const data = Buffer.from('this is not a database '.repeat(10));
		const bundle = join(root, 'fake.zip');
		await writeZip(bundle, [{ name: 'db/sagas.db', data }, manifestFor({ 'db/sagas.db': data })]);
		await refused(bundle, /not a SQLite file|integrity/);
	});

	it('refuses a bundle that unpacks past the limit', async () => {
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle);
		await expect(stageImport(bundle, target, { maxExpandedBytes: 10 })).rejects.toThrow(
			/import limit/
		);
	});

	it('refuses a file in the bundle that the manifest does not list', async () => {
		const data = snapshotOf(db, 'one.db');
		const bundle = join(root, 'extra.zip');
		await writeZip(bundle, [
			{ name: 'db/sagas.db', data },
			{ name: 'extra.sh', data: Buffer.from('rm -rf /') },
			manifestFor({ 'db/sagas.db': data })
		]);
		await refused(bundle, /not in the manifest/);
	});

	describe('zip-slip', () => {
		const names = [
			'attachments/../../escape.txt',
			'attachments/../escape.txt',
			'/etc/escape.txt',
			'attachments//x',
			'attachments/./x',
			'attachments/a\\..\\escape.txt',
			'attachments/'
		];
		for (const name of names) {
			it(`refuses ${JSON.stringify(name)}`, async () => {
				const data = snapshotOf(db, 'one.db');
				const payload = Buffer.from('pwned');
				const bundle = join(root, 'slip.zip');
				await writeZip(bundle, [
					{ name: 'db/sagas.db', data },
					{ name, data: payload },
					manifestFor({ 'db/sagas.db': data, [name]: payload })
				]);
				await refused(bundle, /Unsafe|not in the manifest|in the manifest/);
				expect(existsSync(join(root, 'escape.txt'))).toBe(false);
				expect(existsSync(join(target.dataDir, 'escape.txt'))).toBe(false);
				expect(existsSync(join(target.dataDir, '..', 'escape.txt'))).toBe(false);
			});
		}
	});
});

describe('archive format', () => {
	const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

	it.skipIf(!hasUnzip)('is a zip that standard tools read', async () => {
		const source = layoutAt('source');
		const db = open(source);
		putAttachment(source, 'dir/a.txt', 'abc');
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle);

		const result = spawnSync('unzip', ['-t', bundle], { encoding: 'utf8' });
		expect(result.stdout).toContain('No errors detected');
		const listing = spawnSync('unzip', ['-Z1', bundle], { encoding: 'utf8' }).stdout.split('\n');
		expect(listing).toEqual(['db/sagas.db', 'attachments/dir/a.txt', 'manifest.json', '']);
	});

	it('lists the files with sizes and checksums in the manifest', async () => {
		const source = layoutAt('source');
		const db = open(source);
		putAttachment(source, 'a.txt', 'abc');
		const bundle = join(root, 'out.zip');
		await exportTo(db, source, bundle, { remoteAttachments: () => [{ driver: 's3', key: 'k/1' }] });

		const target = layoutAt('target');
		await stageImport(bundle, target, LIMITS);
		const manifestEntry = (await readDirectory(bundle)).find((e) => e.name === 'manifest.json')!;
		const chunks: Buffer[] = [];
		await pipeEntry(
			bundle,
			manifestEntry,
			new Writable({
				write(chunk, _e, cb) {
					chunks.push(chunk);
					cb();
				}
			})
		);
		const manifest = JSON.parse(Buffer.concat(chunks).toString()) as Manifest;
		expect(manifest).toMatchObject({
			format: 1,
			schema: buildSchema(),
			remoteAttachments: [{ driver: 's3', key: 'k/1' }]
		});
		expect(manifest.files).toContainEqual({
			path: 'attachments/a.txt',
			size: 3,
			sha256: sha('abc')
		});
		expect(manifest.files.map((f) => f.path)).toEqual(['db/sagas.db', 'attachments/a.txt']);
	});
});
