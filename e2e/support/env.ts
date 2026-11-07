import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const port = Number(process.env.E2E_PORT || 4391);
export const origin = `http://localhost:${port}`;

// Workers re-evaluate the config; the env var carries the main process's directory to them.
process.env.E2E_RUN_DIR ||= mkdtempSync(join(tmpdir(), 'sagas-e2e-'));
export const runDir = process.env.E2E_RUN_DIR;
const server = process.env.DATABASE_URL;
if (!server) throw new Error('DATABASE_URL must point at a PostgreSQL server for the e2e run');

// A database of its own on the server DATABASE_URL names; the name keeps the *_test guard.
export const e2eDatabase = 'sagas_e2e_test';
export const serverUrl = server;
export const databaseUrl = (() => {
	const url = new URL(server);
	url.pathname = `/${e2eDatabase}`;
	return url.toString();
})();
export const adminFile = join(runDir, 'admin.json');
