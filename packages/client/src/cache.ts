import { randomBytes } from 'node:crypto';
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

export type CacheEntry<T> = { format: 1; fetchedAt: string; data: T };

export type Warn = (message: string) => void;

const warnOnStderr: Warn = (message) => process.stderr.write(`sagas: ${message}\n`);

export function readCache<T>(dir: string, name: string): CacheEntry<T> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
		if (typeof parsed !== 'object' || parsed === null) return undefined;
		const entry = parsed as Partial<CacheEntry<T>>;
		if (entry.format !== 1 || typeof entry.fetchedAt !== 'string' || !('data' in entry)) {
			return undefined;
		}
		return entry as CacheEntry<T>;
	} catch {
		return undefined;
	}
}

// Never write in place: readers must not see half a file.
export function writeCache<T>(
	dir: string,
	name: string,
	data: T,
	options: { now?: Date; warn?: Warn } = {}
): boolean {
	const path = join(dir, name);
	const tmp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const entry: CacheEntry<T> = {
			format: 1,
			fetchedAt: (options.now ?? new Date()).toISOString(),
			data
		};
		writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* no temp file to remove */
		}
		const reason = error instanceof Error ? error.message : String(error);
		(options.warn ?? warnOnStderr)(`cannot write cache ${path}: ${reason}`);
		return false;
	}
}

export function removeCache(dir: string, name: string): void {
	try {
		rmSync(join(dir, name), { force: true });
	} catch {
		/* removal is best effort */
	}
}

export function listCache(dir: string, sub: string): string[] {
	try {
		return readdirSync(join(dir, sub)).filter((file) => !file.startsWith('.tmp-'));
	} catch {
		return [];
	}
}
