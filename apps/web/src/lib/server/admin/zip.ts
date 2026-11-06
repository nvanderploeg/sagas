import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform, Writable, pipeline } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';

export class ZipError extends Error {}

export type ZipEntry = {
	name: string;
	data: Readable | Buffer;
	done?: (info: { size: number; sha256: string }) => void;
};

const U32 = 0xffffffff;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DESCRIPTOR = 0x8;
const FLAG_UTF8 = 0x800;

function dosStamp(date: Date): { time: number; day: number } {
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
	};
}

function u64(buf: Buffer, offset: number, value: number): void {
	buf.writeBigUInt64LE(BigInt(value), offset);
}

export async function* zipChunks(
	entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
	now = new Date()
): AsyncGenerator<Buffer> {
	const { time, day } = dosStamp(now);
	const central: Buffer[] = [];
	let offset = 0;

	for await (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const localOffset = offset;

		const header = Buffer.alloc(30 + name.length + 20);
		header.writeUInt32LE(SIG_LOCAL, 0);
		header.writeUInt16LE(45, 4);
		header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
		header.writeUInt16LE(8, 8);
		header.writeUInt16LE(time, 10);
		header.writeUInt16LE(day, 12);
		header.writeUInt32LE(U32, 18);
		header.writeUInt32LE(U32, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(20, 28);
		name.copy(header, 30);
		header.writeUInt16LE(1, 30 + name.length);
		header.writeUInt16LE(16, 32 + name.length);
		offset += header.length;
		yield header;

		const hash = createHash('sha256');
		let crc = 0;
		let size = 0;
		const tap = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				crc = crc32(chunk, crc);
				size += chunk.length;
				callback(null, chunk);
			}
		});
		const source = Buffer.isBuffer(entry.data) ? Readable.from([entry.data]) : entry.data;
		const compressed = pipeline(source, tap, createDeflateRaw(), () => {});
		let packed = 0;
		for await (const chunk of compressed) {
			packed += (chunk as Buffer).length;
			offset += (chunk as Buffer).length;
			yield chunk as Buffer;
		}

		const descriptor = Buffer.alloc(24);
		descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
		descriptor.writeUInt32LE(crc, 4);
		u64(descriptor, 8, packed);
		u64(descriptor, 16, size);
		offset += descriptor.length;
		yield descriptor;

		const record = Buffer.alloc(46 + name.length + 28);
		record.writeUInt32LE(SIG_CENTRAL, 0);
		record.writeUInt16LE(45, 4);
		record.writeUInt16LE(45, 6);
		record.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
		record.writeUInt16LE(8, 10);
		record.writeUInt16LE(time, 12);
		record.writeUInt16LE(day, 14);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(U32, 20);
		record.writeUInt32LE(U32, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt16LE(28, 30);
		record.writeUInt32LE(0o100644 * 65536, 38);
		record.writeUInt32LE(U32, 42);
		name.copy(record, 46);
		record.writeUInt16LE(1, 46 + name.length);
		record.writeUInt16LE(24, 48 + name.length);
		u64(record, 50 + name.length, size);
		u64(record, 58 + name.length, packed);
		u64(record, 66 + name.length, localOffset);
		central.push(record);

		entry.done?.({ size, sha256: hash.digest('hex') });
	}

	const directory = Buffer.concat(central);
	const tail = Buffer.alloc(56 + 20 + 22);
	tail.writeUInt32LE(SIG_EOCD64, 0);
	u64(tail, 4, 44);
	tail.writeUInt16LE(45, 12);
	tail.writeUInt16LE(45, 14);
	u64(tail, 24, central.length);
	u64(tail, 32, central.length);
	u64(tail, 40, directory.length);
	u64(tail, 48, offset);
	tail.writeUInt32LE(SIG_LOCATOR64, 56);
	u64(tail, 64, offset + directory.length);
	tail.writeUInt32LE(1, 72);
	tail.writeUInt32LE(SIG_EOCD, 76);
	tail.writeUInt16LE(0xffff, 84);
	tail.writeUInt16LE(0xffff, 86);
	tail.writeUInt32LE(U32, 88);
	tail.writeUInt32LE(U32, 92);
	yield directory;
	yield tail;
}

export type ZipFileEntry = {
	name: string;
	method: number;
	packedSize: number;
	size: number;
	crc: number;
	localOffset: number;
};

export type ZipLimits = { maxEntries: number; maxDirectoryBytes: number };

const EOCD_MIN = 22;

export async function readDirectory(
	file: string,
	limits: ZipLimits = { maxEntries: 100_000, maxDirectoryBytes: 64 * 1024 * 1024 }
): Promise<ZipFileEntry[]> {
	const handle = await open(file, 'r');
	try {
		const { size: fileSize } = await handle.stat();
		const read = async (position: number, length: number): Promise<Buffer> => {
			if (position < 0 || length < 0 || position + length > fileSize) {
				throw new ZipError('Not a valid zip file: a field points outside the file');
			}
			const buf = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buf, 0, length, position);
			if (bytesRead !== length) throw new ZipError('Not a valid zip file: truncated');
			return buf;
		};

		if (fileSize < EOCD_MIN) throw new ZipError('Not a valid zip file');
		const tailLength = Math.min(fileSize, 0xffff + EOCD_MIN);
		const tail = await read(fileSize - tailLength, tailLength);
		let eocd = -1;
		for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
			if (tail.readUInt32LE(i) === SIG_EOCD) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw new ZipError('Not a valid zip file: no end of central directory');
		const eocdPosition = fileSize - tailLength + eocd;

		let count = tail.readUInt16LE(eocd + 10);
		let directorySize = tail.readUInt32LE(eocd + 12);
		let directoryOffset = tail.readUInt32LE(eocd + 16);
		if (count === 0xffff || directorySize === U32 || directoryOffset === U32) {
			const locator = await read(eocdPosition - 20, 20);
			if (locator.readUInt32LE(0) !== SIG_LOCATOR64) {
				throw new ZipError('Not a valid zip file: missing zip64 locator');
			}
			const at = Number(locator.readBigUInt64LE(8));
			const record = await read(at, 56);
			if (record.readUInt32LE(0) !== SIG_EOCD64) {
				throw new ZipError('Not a valid zip file: bad zip64 record');
			}
			count = Number(record.readBigUInt64LE(32));
			directorySize = Number(record.readBigUInt64LE(40));
			directoryOffset = Number(record.readBigUInt64LE(48));
		}
		if (count > limits.maxEntries) throw new ZipError('The archive has too many entries');
		if (directorySize > limits.maxDirectoryBytes) {
			throw new ZipError('The archive directory is too large');
		}

		const directory = await read(directoryOffset, directorySize);
		const entries: ZipFileEntry[] = [];
		let at = 0;
		for (let n = 0; n < count; n++) {
			if (at + 46 > directory.length || directory.readUInt32LE(at) !== SIG_CENTRAL) {
				throw new ZipError('Not a valid zip file: bad directory entry');
			}
			const flags = directory.readUInt16LE(at + 8);
			const method = directory.readUInt16LE(at + 10);
			const crc = directory.readUInt32LE(at + 16);
			let packedSize = directory.readUInt32LE(at + 20);
			let size = directory.readUInt32LE(at + 24);
			const nameLength = directory.readUInt16LE(at + 28);
			const extraLength = directory.readUInt16LE(at + 30);
			const commentLength = directory.readUInt16LE(at + 32);
			let localOffset = directory.readUInt32LE(at + 42);
			const end = at + 46 + nameLength + extraLength + commentLength;
			if (end > directory.length) throw new ZipError('Not a valid zip file: bad directory entry');

			if (flags & FLAG_ENCRYPTED) throw new ZipError('Encrypted archives are not supported');
			if (method !== 0 && method !== 8) throw new ZipError('Unsupported compression method');

			const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
			const extraStart = at + 46 + nameLength;
			for (let x = extraStart; x + 4 <= extraStart + extraLength;) {
				const id = directory.readUInt16LE(x);
				const length = directory.readUInt16LE(x + 2);
				if (id === 1) {
					let p = x + 4;
					const take = (): number => {
						if (p + 8 > x + 4 + length) throw new ZipError('Not a valid zip file: bad zip64 extra');
						const value = Number(directory.readBigUInt64LE(p));
						p += 8;
						return value;
					};
					if (size === U32) size = take();
					if (packedSize === U32) packedSize = take();
					if (localOffset === U32) localOffset = take();
				}
				x += 4 + length;
			}
			if (
				!Number.isSafeInteger(size) ||
				!Number.isSafeInteger(packedSize) ||
				!Number.isSafeInteger(localOffset)
			) {
				throw new ZipError('Not a valid zip file: size out of range');
			}
			entries.push({ name, method, packedSize, size, crc, localOffset });
			at = end;
		}
		return entries;
	} finally {
		await handle.close();
	}
}

export function safeRelativePath(name: string): boolean {
	if (name.length === 0 || name.length > 1024) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
	if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
	return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export type EntryVerifier = Transform & { sha256: () => string };

function verifier(entry: ZipFileEntry): EntryVerifier {
	const hash = createHash('sha256');
	let crc = 0;
	let size = 0;
	let digest = '';
	const stream = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			size += chunk.length;
			if (size > entry.size) {
				callback(new ZipError(`${entry.name} is larger than its directory entry says`));
				return;
			}
			hash.update(chunk);
			crc = crc32(chunk, crc);
			callback(null, chunk);
		},
		flush(callback) {
			if (size !== entry.size || crc !== entry.crc) {
				callback(new ZipError(`${entry.name} is corrupt`));
				return;
			}
			digest = hash.digest('hex');
			callback();
		}
	}) as EntryVerifier;
	stream.sha256 = () => digest;
	return stream;
}

export async function pipeEntry(
	file: string,
	entry: ZipFileEntry,
	sink: Writable
): Promise<string> {
	const handle = await open(file, 'r');
	let dataStart: number;
	try {
		const local = Buffer.alloc(30);
		const { bytesRead } = await handle.read(local, 0, 30, entry.localOffset);
		if (bytesRead !== 30 || local.readUInt32LE(0) !== SIG_LOCAL) {
			throw new ZipError(`${entry.name} has a bad local header`);
		}
		dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
	} finally {
		await handle.close();
	}
	const verify = verifier(entry);
	const raw =
		entry.packedSize === 0
			? Readable.from([])
			: createReadStream(file, { start: dataStart, end: dataStart + entry.packedSize - 1 });
	if (entry.method === 8) await pipelineAsync(raw, createInflateRaw(), verify, sink);
	else await pipelineAsync(raw, verify, sink);
	return verify.sha256();
}
