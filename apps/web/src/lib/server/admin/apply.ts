import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupsDir, pendingDir, quarantineDir, type DataLayout } from './layout.ts';

export const KEPT_BACKUPS = 5;
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;
const BACKUP_PREFIX = 'pre-import-';
const COMPLETE_MARK = '.complete';

function stamp(now: Date): string {
	return now.toISOString().replace(/[:.]/g, '-');
}

function sweepScratch(layout: DataLayout, now: Date): void {
	if (!existsSync(layout.dataDir)) return;
	for (const name of readdirSync(layout.dataDir)) {
		if (!name.startsWith('export-tmp-') && !name.startsWith('import-tmp-')) continue;
		const path = join(layout.dataDir, name);
		if (now.getTime() - statSync(path).mtimeMs > SCRATCH_MAX_AGE_MS) {
			rmSync(path, { recursive: true, force: true });
		}
	}
}

// Only backups of swaps that completed count; the one just made is never pruned.
function pruneBackups(layout: DataLayout, current: string): void {
	if (!existsSync(backupsDir(layout))) return;
	const names = readdirSync(backupsDir(layout))
		.filter(
			(name) =>
				name.startsWith(BACKUP_PREFIX) &&
				join(backupsDir(layout), name) !== current &&
				existsSync(join(backupsDir(layout), name, COMPLETE_MARK))
		)
		.sort();
	for (const name of names.slice(0, Math.max(0, names.length - (KEPT_BACKUPS - 1)))) {
		rmSync(join(backupsDir(layout), name), { recursive: true, force: true });
	}
}

function swap(layout: DataLayout, backup: string): void {
	const pending = pendingDir(layout);
	const stagedDatabase = join(pending, 'sagas.db');
	const stagedAttachments = join(pending, 'attachments');

	mkdirSync(backup, { recursive: true });
	if (existsSync(stagedDatabase) && existsSync(layout.databaseFile)) {
		const current = new Database(layout.databaseFile, { fileMustExist: true });
		try {
			current.prepare('VACUUM INTO ?').run(join(backup, 'sagas.db'));
		} finally {
			current.close();
		}
	}

	if (existsSync(stagedAttachments)) {
		const kept = join(backup, 'attachments');
		const had = existsSync(layout.attachmentsDir);
		try {
			if (had) renameSync(layout.attachmentsDir, kept);
			renameSync(stagedAttachments, layout.attachmentsDir);
			swapDatabase(layout, stagedDatabase);
		} catch (error) {
			if (existsSync(layout.attachmentsDir) && !existsSync(stagedAttachments)) {
				rmSync(layout.attachmentsDir, { recursive: true, force: true });
			}
			if (existsSync(kept)) renameSync(kept, layout.attachmentsDir);
			throw error;
		}
	} else {
		swapDatabase(layout, stagedDatabase);
	}
}

function swapDatabase(layout: DataLayout, staged: string): void {
	if (!existsSync(staged)) return;
	rmSync(`${layout.databaseFile}-wal`, { force: true });
	rmSync(`${layout.databaseFile}-shm`, { force: true });
	renameSync(staged, layout.databaseFile);
}

function quarantine(layout: DataLayout, now: Date): void {
	const target = join(quarantineDir(layout), `import-${stamp(now)}`);
	try {
		mkdirSync(quarantineDir(layout), { recursive: true });
		renameSync(pendingDir(layout), target);
	} catch {
		try {
			rmSync(pendingDir(layout), { recursive: true, force: true });
		} catch (error) {
			console.error('sagas could not quarantine or remove the staged import', error);
		}
	}
}

// Runs before anything opens the database and never throws: a failed swap is quarantined and the
// server boots on the data it has. Every step tolerates a rerun after a crash.
export function applyPendingImport(layout: DataLayout, now = new Date()): string | null {
	try {
		sweepScratch(layout, now);
	} catch (error) {
		console.error('sagas could not sweep scratch directories', error);
	}
	const marker = join(pendingDir(layout), 'import.json');
	if (!existsSync(marker)) return null;
	try {
		JSON.parse(readFileSync(marker, 'utf8'));
	} catch (error) {
		console.error('sagas found an unreadable staged import; booting on current data', error);
		quarantine(layout, now);
		return null;
	}

	const backup = join(backupsDir(layout), `${BACKUP_PREFIX}${stamp(now)}`);
	try {
		swap(layout, backup);
		writeFileSync(join(backup, COMPLETE_MARK), '');
	} catch (error) {
		console.error('sagas could not apply the staged import; booting on current data', error);
		try {
			rmSync(backup, { recursive: true, force: true });
		} catch (cleanup) {
			console.error('sagas could not remove the partial backup', cleanup);
		}
		quarantine(layout, now);
		return null;
	}
	try {
		rmSync(pendingDir(layout), { recursive: true, force: true });
	} catch (error) {
		console.error('sagas could not remove the applied import from import-pending', error);
	}
	try {
		pruneBackups(layout, backup);
	} catch (error) {
		console.error('sagas could not prune old backups', error);
	}
	return backup;
}
