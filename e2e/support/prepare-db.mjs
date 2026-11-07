import pg from 'pg';

const server = process.env.E2E_SERVER_URL;
if (!server) throw new Error('E2E_SERVER_URL must point at a PostgreSQL server');
const name = 'sagas_e2e_test';

const client = new pg.Client({ connectionString: server });
await client.connect();
try {
	await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
	await client.query(`CREATE DATABASE "${name}"`);
} finally {
	await client.end();
}
