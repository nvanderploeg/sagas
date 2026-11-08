import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from '#lib/server/db/client.ts';
import { importBundle, type ImportOptions, type ImportResult } from './import.ts';

export class UploadError extends Error {
	constructor(
		readonly status: 400 | 409 | 413,
		message: string
	) {
		super(message);
	}
}

export const UPLOAD_ID = /^[0-9a-f]{16}$/;
const STALE_MS = 10 * 60 * 1000;

type Session = {
	id: string;
	file: string;
	size: number;
	touchedAt: number;
	writing: boolean;
	importing: boolean;
};

export type Chunk = { id: string; offset: number; body: ReadableStream | Readable; final: boolean };

/** One upload at a time; the bundle arrives in chunks small enough for the server's body limit. */
export function createUploads(
	db: Db,
	options: ImportOptions & { maxBytes: number },
	clock: () => number = Date.now
) {
	let active: Session | null = null;

	async function drop(session: Session): Promise<void> {
		if (active === session) active = null;
		await rm(session.file, { force: true });
	}

	// Everything up to `writing = true` runs synchronously, so two chunks never both get through.
	async function append(chunk: Chunk): Promise<ImportResult | null> {
		if (!UPLOAD_ID.test(chunk.id)) throw new UploadError(400, 'Bad upload id');
		const now = clock();
		let abandoned: Session | null = null;
		if (active && active.id !== chunk.id) {
			if (active.writing || active.importing || now - active.touchedAt < STALE_MS) {
				throw new UploadError(409, 'Another import is in progress');
			}
			abandoned = active;
			active = null;
		}
		let fresh = false;
		if (!active) {
			if (chunk.offset !== 0) throw new UploadError(409, 'The upload is not in progress');
			active = {
				id: chunk.id,
				file: join(tmpdir(), `sagas-upload-${chunk.id}.zip`),
				size: 0,
				touchedAt: now,
				writing: false,
				importing: false
			};
			fresh = true;
		}
		const session = active;
		if (session.writing || session.importing)
			throw new UploadError(409, 'Another import is in progress');
		if (chunk.offset !== session.size) throw new UploadError(409, 'Chunk out of order');
		session.writing = true;
		session.touchedAt = now;

		try {
			if (abandoned) await rm(abandoned.file, { force: true });
			if (fresh) {
				await rm(session.file, { force: true });
			}
			const room = options.maxBytes - session.size;
			let seen = 0;
			const source =
				chunk.body instanceof Readable ? chunk.body : Readable.fromWeb(chunk.body as never);
			await pipeline(
				source,
				new Transform({
					transform(data: Buffer, _encoding, callback) {
						seen += data.length;
						callback(
							seen > room
								? new UploadError(413, 'The bundle is larger than the import limit')
								: null,
							data
						);
					}
				}),
				createWriteStream(session.file, { flags: 'a' })
			);
			session.size += seen;
			if (!chunk.final) {
				session.writing = false;
				return null;
			}
			session.importing = true;
			return await importBundle(db, session.file, options);
		} catch (error) {
			await drop(session);
			throw error;
		} finally {
			if (chunk.final) await drop(session);
		}
	}

	return { append, isBusy: () => active !== null };
}
