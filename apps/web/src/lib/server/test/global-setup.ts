import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { bootstrap } from '#lib/server/db/bootstrap.ts';
import { createPool } from '#lib/server/db/client.ts';

function withDatabase(base: string, name: string): string {
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
}

export default async function setup(): Promise<() => Promise<void>> {
	// One template per run, so runs sharing a server do not drop each other's.
	const template = `sagas_tpl_${randomBytes(4).toString('hex')}_test`;
	const base = process.env.DATABASE_URL;
	if (!base) throw new Error('DATABASE_URL is not set');
	const own = decodeURIComponent(new URL(base).pathname.slice(1));
	if (!own.endsWith('_test')) {
		throw new Error(`refusing to use "${own}": tests need a database named *_test`);
	}
	const admin = new pg.Client({ connectionString: base });
	await admin.connect();
	try {
		await admin.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
		await admin.query(`CREATE DATABASE "${template}"`);
	} finally {
		await admin.end();
	}
	const pool = createPool(withDatabase(base, template), { max: 2 });
	try {
		await bootstrap(pool);
	} finally {
		await pool.end();
	}
	process.env.SAGAS_TEST_TEMPLATE = template;
	return async () => {
		const done = new pg.Client({ connectionString: base });
		await done.connect();
		await done.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
		await done.end();
	};
}
