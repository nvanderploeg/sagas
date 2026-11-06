import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gate } from '#lib/server/auth/access.ts';
import { openDatabase, type Db } from '#lib/server/db/client.ts';
import { KEPT_BACKUPS, applyPendingImport } from './apply.ts';
import { exportBundle } from './export.ts';
import { readPendingImport, stageImport } from './import.ts';
import type { DataLayout } from './layout.ts';
import { UploadError, createUploads } from './upload.ts';
import { readDirectory, zipChunks } from './zip.ts';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

let root: string;
let layout: DataLayout;
const opened: Db[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sagas-resilience-'));
	layout = {
		dataDir: root,
		databaseFile: join(root, 'sagas.db'),
		attachmentsDir: join(root, 'attachments')
	};
});

afterEach(() => {
	for (const db of opened.splice(0)) if (db.$client.open) db.$client.close();
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function stagePending(): void {
	const pending = join(root, 'import-pending');
	mkdirSync(pending, { recursive: true });
	writeFileSync(join(pending, 'import.json'), '{}');
	writeFileSync(join(pending, 'sagas.db'), 'staged');
}

describe('applyPendingImport', () => {
	it('boots on current data, quarantining the staged import, when the swap fails', () => {
		const db = openDatabase(layout.databaseFile);
		db.$client.close();
		writeFileSync(join(root, 'backups'), 'a file where the backups directory belongs');
		stagePending();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(applyPendingImport(layout)).toBeNull();

		expect(log).toHaveBeenCalled();
		expect(existsSync(join(root, 'import-pending'))).toBe(false);
		const [held] = readdirSync(join(root, 'quarantine'));
		expect(readFileSync(join(root, 'quarantine', held, 'sagas.db'), 'utf8')).toBe('staged');
		const again = openDatabase(layout.databaseFile);
		opened.push(again);
		expect(again.$client.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
	});

	it('puts the old attachments back when the database swap fails', () => {
		const old = openDatabase(layout.databaseFile);
		old.$client.close();
		mkdirSync(layout.attachmentsDir);
		writeFileSync(join(layout.attachmentsDir, 'old.txt'), 'old');
		stagePending();
		mkdirSync(join(root, 'import-pending', 'attachments'));
		writeFileSync(join(root, 'import-pending', 'attachments', 'new.txt'), 'new');
		rmSync(layout.databaseFile);
		mkdirSync(layout.databaseFile);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(applyPendingImport(layout)).toBeNull();

		expect(readFileSync(join(layout.attachmentsDir, 'old.txt'), 'utf8')).toBe('old');
		expect(existsSync(join(layout.attachmentsDir, 'new.txt'))).toBe(false);
	});

	it('keeps only the newest backups', () => {
		const old = openDatabase(layout.databaseFile);
		old.$client.close();
		for (let i = 1; i <= KEPT_BACKUPS + 2; i++) {
			const old = join(root, 'backups', `pre-import-2020-01-0${i}T00-00-00-000Z`);
			mkdirSync(old, { recursive: true });
			if (i !== 2) writeFileSync(join(old, '.complete'), '');
		}
		mkdirSync(join(root, 'backups', 'mine'));
		stagePending();
		const fresh = openDatabase(join(root, 'fresh.db'));
		fresh.$client.close();
		writeFileSync(join(root, 'import-pending', 'sagas.db'), readFileSync(join(root, 'fresh.db')));

		applyPendingImport(layout, new Date('2021-01-01T00:00:00Z'));

		const kept = readdirSync(join(root, 'backups')).filter((n) => n.startsWith('pre-import-'));
		expect(kept).toHaveLength(KEPT_BACKUPS + 1);
		expect(kept).toContain('pre-import-2021-01-01T00-00-00-000Z');
		expect(kept).toContain('pre-import-2020-01-02T00-00-00-000Z');
		expect(kept).not.toContain('pre-import-2020-01-01T00-00-00-000Z');
		expect(existsSync(join(root, 'backups', 'mine'))).toBe(true);
	});

	it('removes only scratch directories older than an hour', () => {
		const stale = join(root, 'import-tmp-old');
		const young = join(root, 'export-tmp-young');
		mkdirSync(stale);
		mkdirSync(young);
		const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(stale, longAgo, longAgo);

		applyPendingImport(layout);

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(young)).toBe(true);
	});
});

describe('a corrupt staged import', () => {
	it('is quarantined at start rather than applied', () => {
		stagePending();
		writeFileSync(join(root, 'import-pending', 'import.json'), '{not json');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(applyPendingImport(layout)).toBeNull();
		expect(readdirSync(join(root, 'quarantine'))).toHaveLength(1);
	});

	it('is reported as corrupt, not thrown', async () => {
		stagePending();
		writeFileSync(join(root, 'import-pending', 'import.json'), '[]');
		expect(await readPendingImport(layout)).toBe('corrupt');
		rmSync(join(root, 'import-pending', 'import.json'));
		expect(await readPendingImport(layout)).toBe('corrupt');
	});
});

describe('uploads', () => {
	const options = { maxBytes: 1000, maxExpandedBytes: 4000 };
	const chunk = (id: string, offset: number, text: string, final = false) => ({
		id,
		offset,
		body: Readable.from([Buffer.from(text)]),
		final
	});
	const A = 'a'.repeat(16);
	const B = 'b'.repeat(16);

	it('gives a second concurrent upload a 409 and lets the first finish', async () => {
		const uploads = createUploads(layout, options);
		await uploads.append(chunk(A, 0, 'abc'));

		await expect(uploads.append(chunk(B, 0, 'xyz'))).rejects.toMatchObject({ status: 409 });
		await expect(uploads.append(chunk(A, 3, 'def'))).resolves.toBeNull();
	});

	it('refuses a chunk that races a first chunk of another upload, without orphaning files', async () => {
		const uploads = createUploads(layout, options);
		const results = await Promise.allSettled([
			uploads.append(chunk(A, 0, 'abc')),
			uploads.append(chunk(B, 0, 'xyz'))
		]);

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
		expect(readdirSync(root).filter((n) => n.startsWith('import-tmp-'))).toEqual([
			`import-tmp-upload-${A}.zip`
		]);
	});

	it('refuses a duplicate of a chunk in flight and appends it once', async () => {
		const uploads = createUploads(layout, options);
		await uploads.append(chunk(A, 0, 'abc'));
		const results = await Promise.allSettled([
			uploads.append(chunk(A, 3, 'def')),
			uploads.append(chunk(A, 3, 'def'))
		]);

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
		expect(readFileSync(join(root, `import-tmp-upload-${A}.zip`), 'utf8')).toBe('abcdef');
		await expect(uploads.append(chunk(A, 6, 'g'))).resolves.toBeNull();
	});

	it('lets a new upload replace one abandoned for ten minutes', async () => {
		let now = 0;
		const uploads = createUploads(layout, options, () => now);
		await uploads.append(chunk(A, 0, 'abc'));
		now = 11 * 60 * 1000;

		await expect(uploads.append(chunk(B, 0, 'xyz'))).resolves.toBeNull();
		expect(existsSync(join(root, `import-tmp-upload-${A}.zip`))).toBe(false);
	});

	it('refuses out-of-order chunks, bad ids, and more than the cap', async () => {
		const uploads = createUploads(layout, options);
		await expect(uploads.append(chunk('nope', 0, 'x'))).rejects.toMatchObject({ status: 400 });
		await expect(uploads.append(chunk(A, 5, 'x'))).rejects.toMatchObject({ status: 409 });
		await uploads.append(chunk(A, 0, 'abc'));
		await expect(uploads.append(chunk(A, 0, 'abc'))).rejects.toBeInstanceOf(UploadError);
		const big = createUploads(layout, options);
		await expect(big.append(chunk(B, 0, 'z'.repeat(1001)))).rejects.toMatchObject({
			status: 413
		});
		expect(readdirSync(root).filter((n) => n.includes(B))).toEqual([]);
	});

	it('serialises staging itself', async () => {
		const bundle = join(root, 'junk.zip');
		writeFileSync(bundle, Buffer.alloc(100, 1));
		const results = await Promise.allSettled([
			stageImport(bundle, layout, { maxExpandedBytes: 10 }),
			stageImport(bundle, layout, { maxExpandedBytes: 10 })
		]);
		expect(
			results.map((r) => (r.status === 'rejected' ? r.reason.constructor.name : 'ok'))
		).toContain('BusyError');
	});
});

describe('export', () => {
	it('lists attachments with names import would refuse as skipped, so the bundle re-imports', async () => {
		const db = openDatabase(layout.databaseFile);
		opened.push(db);
		mkdirSync(layout.attachmentsDir);
		writeFileSync(join(layout.attachmentsDir, 'good.txt'), 'ok');
		writeFileSync(join(layout.attachmentsDir, 'back\\slash.txt'), 'bad');
		const { stream } = await exportBundle(db, layout);
		const file = join(root, 'out.zip');
		await pipeline(stream, createWriteStream(file));

		const names = (await readDirectory(file)).map((e) => e.name);
		expect(names).toEqual(['db/sagas.db', 'attachments/good.txt', 'manifest.json']);
		const target = { ...layout, dataDir: join(root, 'target') };
		mkdirSync(target.dataDir);
		await expect(stageImport(file, target, { maxExpandedBytes: 1e9 })).resolves.toMatchObject({
			files: 2
		});
	});

	it('removes its scratch snapshot when the client goes away before reading', async () => {
		const db = openDatabase(layout.databaseFile);
		opened.push(db);
		const { stream } = await exportBundle(db, layout);
		expect(readdirSync(root).some((n) => n.startsWith('export-tmp-'))).toBe(true);

		stream.destroy();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(readdirSync(root).filter((n) => n.startsWith('export-tmp-'))).toEqual([]);
	});

	it('lists symlinks as skipped', async () => {
		const db = openDatabase(layout.databaseFile);
		opened.push(db);
		mkdirSync(layout.attachmentsDir);
		writeFileSync(join(root, 'secret.txt'), 'outside');
		symlinkSync(join(root, 'secret.txt'), join(layout.attachmentsDir, 'link.txt'));
		const { stream } = await exportBundle(db, layout);
		const file = join(root, 'out.zip');
		await pipeline(stream, createWriteStream(file));

		expect((await readDirectory(file)).map((e) => e.name)).toEqual([
			'db/sagas.db',
			'manifest.json'
		]);
	});

	it('fails the stream when a source breaks mid-archive instead of ending it cleanly', async () => {
		const broken = new PassThrough();
		const chunks = zipChunks([{ name: 'a', data: broken }]);
		setTimeout(() => {
			broken.write('partial');
			broken.destroy(new Error('disk gone'));
		}, 5);
		const stream = Readable.from(chunks);

		await expect(
			(async () => {
				for await (const _ of stream) void _;
			})()
		).rejects.toThrow('disk gone');
	});
});

describe('gate with encoded paths', () => {
	const signedOut = { setupDone: true, signedIn: false };

	it('never passes an encoded spelling of a protected path', () => {
		for (const path of [
			'/%61dmin/export',
			'/admin%2Fexport',
			'/admin/%69mport',
			'/%6Cogin/../admin'
		]) {
			expect(gate(path, signedOut), path).toBe('login');
		}
	});
});
