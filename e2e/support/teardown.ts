import { rmSync } from 'node:fs';
import pg from 'pg';
import { e2eDatabase, runDir, serverUrl } from './env.ts';

export default async function teardown(): Promise<void> {
	rmSync(runDir, { recursive: true, force: true });
	const client = new pg.Client({ connectionString: serverUrl });
	await client.connect();
	try {
		await client.query(`DROP DATABASE IF EXISTS "${e2eDatabase}" WITH (FORCE)`);
	} finally {
		await client.end();
	}
}
