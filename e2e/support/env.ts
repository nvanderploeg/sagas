import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const port = Number(process.env.E2E_PORT || 4391);
export const origin = `http://localhost:${port}`;

// Workers re-evaluate the config; the env var carries the main process's directory to them.
process.env.E2E_RUN_DIR ||= mkdtempSync(join(tmpdir(), 'sagas-e2e-'));
export const runDir = process.env.E2E_RUN_DIR;
export const databasePath = join(runDir, 'sagas.db');
export const adminFile = join(runDir, 'admin.json');
