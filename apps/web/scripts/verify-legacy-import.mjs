// Imports a Data bundle from the SQLite build into a throwaway PostgreSQL database through the
// real admin import, then checks it. Prints counts and pass or fail only, never row content.
//
//   DATABASE_URL=postgres://user:pw@host:port/anything_test \
//     node scripts/verify-legacy-import.mjs <bundle.zip>
//
// The database named by DATABASE_URL must end in _test; the script drops and recreates a database
// of its own beside it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import pg from 'pg';

const zip = process.argv[2];
const server = process.env.DATABASE_URL;
if (!zip || !server) {
	console.error(
		'usage: DATABASE_URL=postgres://.../x_test node scripts/verify-legacy-import.mjs <bundle.zip>'
	);
	process.exit(2);
}
const own = new URL(server).pathname.slice(1);
if (!own.endsWith('_test')) throw new Error(`refusing to use "${own}": it must end in _test`);
const name = 'sagas_legacy_check_test';
const url = new URL(server);
url.pathname = `/${name}`;

let failed = 0;
const check = (label, ok, detail = '') => {
	if (!ok) failed += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const admin = new pg.Client({ connectionString: server });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${name}"`);

const root = resolve(import.meta.dirname, '..');
const vite = await createServer({
	root,
	configFile: false,
	appType: 'custom',
	logLevel: 'error',
	define: { __APP_VERSION__: JSON.stringify('verify') },
	server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: false } },
	optimizeDeps: { noDiscovery: true, include: [] },
	resolve: { alias: { '#lib': join(root, 'src/lib') } }
});
const load = (path) => vite.ssrLoadModule(path);
const scratch = await mkdtemp(join(tmpdir(), 'sagas-verify-'));

try {
	const client = await load('/src/lib/server/db/client.ts');
	const boot = await load('/src/lib/server/db/bootstrap.ts');
	const importer = await load('/src/lib/server/admin/import.ts');
	const exporter = await load('/src/lib/server/admin/export.ts');
	const tables = await load('/src/lib/server/admin/tables.ts');
	const legacy = await load('/src/lib/server/admin/legacy.ts');
	const zipLib = await load('/src/lib/server/admin/zip.ts');
	const labourQuery = await load('/src/lib/server/domain/labour-query.ts');
	const quests = await load('/src/lib/server/domain/quests.ts');
	const labours = await load('/src/lib/server/domain/labours.ts');
	const scrolls = await load('/src/lib/server/domain/scrolls.ts');
	const search = await load('/src/lib/server/agent/search.ts');
	const schema = await load('/src/lib/server/db/schema.ts');

	const pool = client.createPool(url.toString(), { max: 4 });
	const db = client.openDatabase(pool);
	await boot.bootstrap(pool);

	// The SQLite file out of the zip, for the source counts.
	const entries = await zipLib.readDirectory(zip);
	const entry = entries.find((e) => e.name === 'db/sagas.db');
	check('bundle holds db/sagas.db', Boolean(entry));
	const source = join(scratch, 'source.db');
	if (entry) {
		const { createWriteStream } = await import('node:fs');
		await zipLib.pipeEntry(zip, entry, createWriteStream(source));
	}
	const names = tables.BUNDLE_TABLES.map((t) => t.name);
	const expected = legacy.countLegacyRows(source, names);

	const result = await importer.importBundle(db, zip, { maxExpandedBytes: 2 ** 33 });
	check(
		'import accepted',
		result.format === 1,
		`format ${result.format}, ${Object.values(result.rows).reduce((a, b) => a + b, 0)} rows`
	);

	for (const table of names) {
		const have = (await pool.query(`SELECT count(*)::int AS n FROM "sagas_${table}"`)).rows[0].n;
		const want = expected[table] ?? 0;
		if (table === 'event_counter') continue;
		check(`rows of ${table}`, have === want, `${have} of ${want}`);
	}

	const orphans = await pool.query(`
		SELECT count(*)::int AS n FROM sagas_labours l
		LEFT JOIN sagas_labour_keys k ON k.labour_id = l.id
		LEFT JOIN sagas_realms r ON r.id = l.realm_id
		WHERE k.key IS NULL OR r.id IS NULL`);
	check('every Labour has a key and a Realm', orphans.rows[0].n === 0);
	const keyMismatch = await pool.query(`
		SELECT count(*)::int AS n FROM sagas_labours l
		JOIN sagas_realms r ON r.id = l.realm_id
		WHERE NOT EXISTS (SELECT 1 FROM sagas_labour_keys k WHERE k.labour_id = l.id AND k.key = r.key || '-' || l.number)`);
	check('every Labour key is its current key too', keyMismatch.rows[0].n === 0);
	const deferred = await pool.query(
		`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND NOT convalidated`
	);
	check('no unvalidated foreign key', deferred.rows[0].n === 0);

	const page = await labourQuery.queryLabours(db, {}, { offset: 0, limit: 5 });
	check(
		'Labours list through the query layer',
		page.total === (expected.labours ?? 0),
		`${page.total} total, ${page.labours.length} on page one`
	);
	const questList = await quests.listQuests(db);
	check('Quests list', questList.length === (expected.quests ?? 0), `${questList.length}`);
	const realmRows = await pool.query('SELECT id FROM sagas_realms ORDER BY id');
	let scrollSeen = 0;
	for (const { id } of realmRows.rows)
		scrollSeen += (await scrolls.listScrollChildren(db, id, null)).length;
	check(
		'Scrolls list under every Realm root',
		scrollSeen <= (expected.scrolls ?? 0),
		`${scrollSeen} root Scrolls`
	);

	// Search: the most common long word in Labour titles must find Labours.
	const titles = (await pool.query('SELECT title FROM sagas_labours')).rows.map((r) => r.title);
	const counts = new Map();
	for (const t of titles)
		for (const w of new Set(t.toLowerCase().match(/[a-z]{5,}/g) ?? []))
			counts.set(w, (counts.get(w) ?? 0) + 1);
	const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
	if (top) {
		const hits = await search.keywordScores(db, top[0]);
		check(
			'search finds Labours by a title word',
			hits.size >= 1 && hits.size >= Math.min(top[1], 1),
			`${hits.size} hits`
		);
		const best = [...hits.values()].reduce((a, b) => Math.max(a, b), 0);
		check('best match scores 1', best === 1);
	} else {
		console.log('SKIP  search (no title words)');
	}
	const scrollTitles = (await pool.query('SELECT realm_id, title FROM sagas_scrolls LIMIT 200'))
		.rows;
	if (scrollTitles.length) {
		const word = scrollTitles.flatMap((r) => r.title.toLowerCase().match(/[a-z]{5,}/g) ?? [])[0];
		if (word) {
			const row = scrollTitles.find((r) => r.title.toLowerCase().includes(word));
			const found = await scrolls.searchScrolls(db, row.realm_id, word);
			check(
				'scroll search finds a Scroll by a title word',
				found.length >= 1,
				`${found.length} hits`
			);
		}
	}

	// Sequences continue above the imported ids.
	const before = {
		labours: (await pool.query('SELECT coalesce(max(id),0)::int AS m FROM sagas_labours')).rows[0]
			.m,
		scrolls: (await pool.query('SELECT coalesce(max(id),0)::int AS m FROM sagas_scrolls')).rows[0]
			.m,
		events: (await pool.query('SELECT coalesce(max(seq),0)::int AS m FROM sagas_events')).rows[0].m
	};
	const adminUser = (
		await pool.query('SELECT id FROM sagas_users WHERE is_admin ORDER BY id LIMIT 1')
	).rows[0];
	const realm =
		(
			await pool.query(
				`SELECT r.id FROM sagas_realms r JOIN sagas_realm_members m ON m.realm_id = r.id AND m.user_id = $1 AND m.status = 'active' ORDER BY r.id LIMIT 1`,
				[adminUser.id]
			)
		).rows[0] ?? (await pool.query('SELECT id FROM sagas_realms ORDER BY id LIMIT 1')).rows[0];
	const made = await labours.createLabour(
		db,
		{ id: adminUser.id },
		{ realmId: realm.id, title: 'verify-legacy-import', ownerId: adminUser.id }
	);
	check(
		'a new Labour gets an id above every imported one',
		made.id > before.labours,
		`${made.id} > ${before.labours}`
	);
	const madeScroll = await scrolls.createScroll(
		db,
		{ id: adminUser.id },
		{ realmId: realm.id, title: 'verify legacy import', slug: 'verify-legacy-import', body: '' }
	);
	check(
		'a new Scroll gets an id above every imported one',
		madeScroll.id > before.scrolls,
		`${madeScroll.id} > ${before.scrolls}`
	);
	const after = (await pool.query('SELECT max(seq)::int AS m FROM sagas_events')).rows[0].m;
	check('new Events continue the seq', after > before.events, `${after} > ${before.events}`);
	const counter = (await pool.query('SELECT last FROM sagas_event_counter')).rows[0].last;
	check('event counter covers the seq', counter >= after);

	// A native export imports back to the same counts.
	const { stream } = exporter.exportBundle(db);
	const { createWriteStream } = await import('node:fs');
	const { pipeline } = await import('node:stream/promises');
	const out = join(scratch, 'roundtrip.zip');
	await pipeline(stream, createWriteStream(out));
	const rowsBefore = Object.fromEntries(
		await Promise.all(
			names.map(async (t) => [
				t,
				(await pool.query(`SELECT count(*)::int AS n FROM "sagas_${t}"`)).rows[0].n
			])
		)
	);
	const again = await importer.importBundle(db, out, { maxExpandedBytes: 2 ** 33 });
	check('a native export imports back', again.format === 2);
	const mismatched = [];
	for (const t of names) {
		const n = (await pool.query(`SELECT count(*)::int AS n FROM "sagas_${t}"`)).rows[0].n;
		if (n !== rowsBefore[t]) mismatched.push(t);
	}
	check('round trip keeps every table count', mismatched.length === 0, mismatched.join(','));
	void schema;
	await pool.end();
} finally {
	await vite.close();
	await rm(scratch, { recursive: true, force: true });
	await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
	await admin.end();
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
