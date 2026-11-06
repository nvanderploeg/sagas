import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Db } from '#lib/server/db/client.ts';
import type { DataLayout } from './layout.ts';
import {
	ATTACHMENT_PREFIX,
	DATABASE_NAME,
	FORMAT,
	MANIFEST_NAME,
	isBundledPath,
	appliedMigrations,
	schemaOf,
	type Manifest
} from './manifest.ts';
import { zipChunks, type ZipEntry } from './zip.ts';

export type RemoteAttachment = { driver: string; key: string };

export type ExportOptions = {
	appVersion?: string;
	now?: Date;
	// Attachments whose bytes live in a bucket: listed in the manifest, never copied.
	remoteAttachments?: (db: Db) => RemoteAttachment[];
};

async function localAttachments(
	root: string
): Promise<{ files: string[]; skipped: Manifest['skipped'] }> {
	const files: string[] = [];
	const skipped: Manifest['skipped'] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		let names;
		try {
			names = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		for (const item of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (item.isDirectory()) await walk(join(dir, item.name), `${prefix}${item.name}/`);
			else if (item.isFile()) files.push(`${prefix}${item.name}`);
			else {
				skipped.push({
					path: `${ATTACHMENT_PREFIX}${prefix}${item.name}`,
					reason: 'not a regular file'
				});
			}
		}
	};
	await walk(root, '');
	return { files, skipped };
}

export async function exportBundle(
	db: Db,
	layout: DataLayout,
	options: ExportOptions = {}
): Promise<{ stream: Readable; filename: string }> {
	const now = options.now ?? new Date();
	const scratch = join(layout.dataDir, `export-tmp-${randomBytes(6).toString('hex')}`);
	await mkdir(scratch, { recursive: true });
	try {
		const snapshot = join(scratch, 'sagas.db');
		db.$client.prepare('VACUUM INTO ?').run(snapshot);
		const schema = schemaOf(appliedMigrations(db.$client));
		const found = await localAttachments(layout.attachmentsDir);
		const attachments = found.files;
		const remote = options.remoteAttachments?.(db) ?? [];

		const files: Manifest['files'] = [];
		const skipped: Manifest['skipped'] = [...found.skipped];
		const record = (path: string) => (info: { size: number; sha256: string }) => {
			files.push({ path, ...info });
		};

		async function* entries(): AsyncGenerator<ZipEntry> {
			yield {
				name: DATABASE_NAME,
				data: createReadStream(snapshot),
				done: record(DATABASE_NAME)
			};
			for (const rel of attachments) {
				const path = `${ATTACHMENT_PREFIX}${rel}`;
				if (!isBundledPath(path)) {
					skipped.push({ path, reason: 'name cannot be imported' });
					continue;
				}
				let handle;
				try {
					handle = await open(join(layout.attachmentsDir, rel), 'r');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					skipped.push({ path, reason: 'vanished during export' });
					continue;
				}
				yield { name: path, data: handle.createReadStream(), done: record(path) };
			}
			const manifest: Manifest = {
				format: FORMAT,
				appVersion: options.appVersion ?? __APP_VERSION__,
				createdAt: now.toISOString(),
				schema,
				files,
				skipped,
				remoteAttachments: remote
			};
			yield { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2)) };
		}

		async function* chunks() {
			try {
				yield* zipChunks(entries(), now);
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		}

		const stream = Readable.from(chunks());
		stream.on('close', () => {
			void rm(scratch, { recursive: true, force: true });
		});
		return {
			stream,
			filename: `sagas-export-${now.toISOString().slice(0, 10)}.zip`
		};
	} catch (error) {
		await rm(scratch, { recursive: true, force: true });
		throw error;
	}
}
