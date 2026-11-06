import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { openDatabase } from '#lib/server/db/client.ts';
import { pendingDir, type DataLayout } from './layout.ts';
import {
	ATTACHMENT_PREFIX,
	BundleError,
	DATABASE_NAME,
	FORMAT,
	MANIFEST_NAME,
	appliedMigrations,
	buildSchema,
	checkHistory,
	isBundledPath,
	manifestSchema,
	schemaOf,
	type Manifest,
	type Schema
} from './manifest.ts';
import { ZipError, pipeEntry, readDirectory, safeRelativePath, type ZipFileEntry } from './zip.ts';

export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const FREE_SPACE_MARGIN = 1.1;

export type PendingImport = {
	stagedAt: string;
	bundleCreatedAt: string;
	bundleAppVersion: string;
	bundleSchema: Schema;
	files: number;
	bytes: number;
};

export type ImportOptions = {
	maxExpandedBytes: number;
	now?: Date;
};

async function readEntryText(file: string, entry: ZipFileEntry, max: number): Promise<string> {
	if (entry.size > max) throw new BundleError(`${entry.name} is too large`);
	const chunks: Buffer[] = [];
	await pipeEntry(
		file,
		entry,
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunks.push(chunk);
				callback();
			}
		})
	);
	return Buffer.concat(chunks).toString('utf8');
}

async function extractEntry(
	file: string,
	entry: ZipFileEntry,
	destination: string
): Promise<string> {
	await mkdir(dirname(destination), { recursive: true });
	try {
		return await pipeEntry(file, entry, createWriteStream(destination, { flags: 'wx' }));
	} catch (error) {
		if (String((error as NodeJS.ErrnoException).code).startsWith('Z_')) {
			throw new BundleError(`${entry.name} is corrupt`);
		}
		throw error;
	}
}

function within(root: string, path: string): boolean {
	const base = resolve(root) + sep;
	return resolve(path).startsWith(base);
}

function parseManifest(text: string): Manifest {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new BundleError('manifest.json is not valid JSON');
	}
	const head = (json as { format?: unknown } | null)?.format;
	if (typeof head === 'number' && head > FORMAT) {
		throw new BundleError(`The bundle format ${head} is newer than this build reads (${FORMAT})`);
	}
	const parsed = manifestSchema.safeParse(json);
	if (!parsed.success) throw new BundleError('manifest.json is malformed');
	if (parsed.data.format !== FORMAT) {
		throw new BundleError(`Unsupported bundle format ${parsed.data.format}`);
	}
	return parsed.data;
}

export class BusyError extends Error {}

let staging = false;

export async function stageImport(
	zipFile: string,
	layout: DataLayout,
	options: ImportOptions
): Promise<PendingImport> {
	if (staging) throw new BusyError('Another import is being staged');
	staging = true;
	try {
		return await stageGuarded(zipFile, layout, options);
	} finally {
		staging = false;
	}
}

async function stageGuarded(
	zipFile: string,
	layout: DataLayout,
	options: ImportOptions
): Promise<PendingImport> {
	const stage = join(layout.dataDir, `import-tmp-${randomBytes(6).toString('hex')}`);
	try {
		return await stageInto(stage, zipFile, layout, options);
	} catch (error) {
		await rm(stage, { recursive: true, force: true });
		if (error instanceof ZipError) throw new BundleError(error.message);
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOTDIR' || code === 'EEXIST' || code === 'EISDIR') {
			throw new BundleError('The bundle has paths that collide');
		}
		throw error;
	}
}

async function stageInto(
	stage: string,
	zipFile: string,
	layout: DataLayout,
	options: ImportOptions
): Promise<PendingImport> {
	const entries = await readDirectory(zipFile);

	const byName = new Map<string, ZipFileEntry>();
	for (const entry of entries) {
		if (entry.name.endsWith('/') && entry.size === 0) continue;
		if (byName.has(entry.name)) throw new BundleError(`The bundle repeats ${entry.name}`);
		byName.set(entry.name, entry);
	}
	const manifestEntry = byName.get(MANIFEST_NAME);
	if (!manifestEntry) throw new BundleError('The bundle has no manifest.json');
	const manifest = parseManifest(await readEntryText(zipFile, manifestEntry, MAX_MANIFEST_BYTES));

	const build = buildSchema();
	if (manifest.schema.level > build.level || manifest.schema.latest > build.latest) {
		throw new BundleError(
			`The bundle's schema (${manifest.schema.level} migrations) is newer than this build (${build.level}). Upgrade this server first.`
		);
	}

	const listed = new Map<string, Manifest['files'][number]>();
	for (const file of manifest.files) {
		if (!isBundledPath(file.path)) throw new BundleError(`Unsafe or unknown path ${file.path}`);
		if (listed.has(file.path)) throw new BundleError(`The manifest repeats ${file.path}`);
		listed.set(file.path, file);
	}
	if (!listed.has(DATABASE_NAME)) throw new BundleError('The bundle has no database');
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
	if (total > options.maxExpandedBytes) {
		throw new BundleError('The bundle unpacks to more than the import limit allows');
	}
	await mkdir(layout.dataDir, { recursive: true });
	const space = await statfs(layout.dataDir);
	if (total * FREE_SPACE_MARGIN > space.bavail * space.bsize) {
		throw new BundleError('Not enough free disk space to unpack the bundle');
	}

	await mkdir(join(stage, 'attachments'), { recursive: true });
	const databaseFile = join(stage, 'sagas.db');
	const targets = [
		listed.get(DATABASE_NAME)!,
		...[...listed.values()].filter((f) => f.path !== DATABASE_NAME)
	];
	for (const file of targets) {
		const entry = byName.get(file.path)!;
		const destination =
			file.path === DATABASE_NAME
				? databaseFile
				: join(stage, 'attachments', file.path.slice(ATTACHMENT_PREFIX.length));
		if (!within(stage, destination) || !safeRelativePath(file.path)) {
			throw new BundleError(`Unsafe path ${file.path}`);
		}
		const digest = await extractEntry(zipFile, entry, destination);
		if (digest !== file.sha256) throw new BundleError(`${file.path} fails its checksum`);
		if (file.path === DATABASE_NAME) checkDatabase(databaseFile, manifest);
	}

	let migrated: ReturnType<typeof openDatabase>;
	try {
		migrated = openDatabase(databaseFile);
	} catch {
		throw new BundleError('The bundle database could not be migrated to this build');
	}
	try {
		migrated.$client.pragma('wal_checkpoint(TRUNCATE)');
		migrated.$client.pragma('journal_mode = DELETE');
	} finally {
		migrated.$client.close();
	}

	const pending: PendingImport = {
		stagedAt: (options.now ?? new Date()).toISOString(),
		bundleCreatedAt: manifest.createdAt,
		bundleAppVersion: manifest.appVersion,
		bundleSchema: manifest.schema,
		files: listed.size,
		bytes: total
	};
	await writeFile(join(stage, 'import.json'), JSON.stringify(pending, null, 2));
	await rm(pendingDir(layout), { recursive: true, force: true });
	await rename(stage, pendingDir(layout));
	return pending;
}

function checkDatabase(file: string, manifest: Manifest): void {
	let sqlite: Database.Database;
	try {
		sqlite = new Database(file, { readonly: true, fileMustExist: true });
	} catch {
		throw new BundleError('The bundle database is not a SQLite file');
	}
	try {
		let check: unknown;
		try {
			check = sqlite.pragma('integrity_check', { simple: true });
		} catch {
			throw new BundleError('The bundle database is not a SQLite file');
		}
		if (check !== 'ok') throw new BundleError('The bundle database fails its integrity check');
		const applied = appliedMigrations(sqlite);
		checkHistory(applied);
		const actual = schemaOf(applied);
		if (actual.level !== manifest.schema.level || actual.latest !== manifest.schema.latest) {
			throw new BundleError('The manifest schema does not match the bundle database');
		}
	} finally {
		sqlite.close();
	}
}

export async function readPendingImport(
	layout: DataLayout
): Promise<PendingImport | 'corrupt' | null> {
	try {
		const parsed = JSON.parse(await readFile(join(pendingDir(layout), 'import.json'), 'utf8'));
		const ok =
			parsed &&
			typeof parsed.stagedAt === 'string' &&
			typeof parsed.bundleCreatedAt === 'string' &&
			typeof parsed.bundleAppVersion === 'string' &&
			typeof parsed.bundleSchema?.level === 'number' &&
			typeof parsed.files === 'number' &&
			typeof parsed.bytes === 'number';
		return ok ? parsed : 'corrupt';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return existsSync(pendingDir(layout)) ? 'corrupt' : null;
		}
		return 'corrupt';
	}
}

export async function discardPendingImport(layout: DataLayout): Promise<void> {
	await rm(pendingDir(layout), { recursive: true, force: true });
}
