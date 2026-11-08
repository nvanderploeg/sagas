import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keywordScores } from '#lib/server/agent/search.ts';
import type { Db } from '#lib/server/db/client.ts';
import { createLabour } from '#lib/server/domain/labours.ts';
import { createScroll } from '#lib/server/domain/scrolls.ts';
import { queryLabours } from '#lib/server/domain/labour-query.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { importBundle } from './import.ts';
import { BundleError, LEGACY_LEVEL, type Manifest } from './manifest.ts';
import { zipChunks, type ZipEntry } from './zip.ts';

const LIMITS = { maxExpandedBytes: 1024 * 1024 * 1024 };

// The SQLite build's tables, reduced to the ones a bundle needs to exercise every kind of value.
const LEGACY_DDL = `
CREATE TABLE users (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, kind text NOT NULL, is_admin integer NOT NULL DEFAULT 0, username text NOT NULL, display_name text NOT NULL, password_hash text, must_change_password integer NOT NULL DEFAULT 0, created_at integer NOT NULL);
CREATE TABLE sessions (id text PRIMARY KEY NOT NULL, user_id integer NOT NULL, created_at integer NOT NULL, expires_at integer NOT NULL);
CREATE TABLE api_tokens (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, user_id integer NOT NULL, name text NOT NULL, token_hash text NOT NULL, created_at integer NOT NULL, last_used_at integer, revoked_at integer, expires_at integer, grant_id integer);
CREATE TABLE realms (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL, key text NOT NULL, labour_counter integer NOT NULL DEFAULT 0, initial_state_id integer);
CREATE TABLE realm_keys (key text PRIMARY KEY NOT NULL, realm_id integer NOT NULL, created_at integer NOT NULL);
CREATE TABLE realm_members (realm_id integer NOT NULL, user_id integer NOT NULL, role text NOT NULL, status text NOT NULL, invited_by integer, created_at integer NOT NULL, accepted_at integer, PRIMARY KEY (realm_id, user_id));
CREATE TABLE states (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, realm_id integer NOT NULL, key text NOT NULL, label text NOT NULL, color text NOT NULL, icon text NOT NULL, position integer NOT NULL, is_closed integer NOT NULL DEFAULT 0, is_open integer NOT NULL DEFAULT 1, default_substate_id integer);
CREATE TABLE labours (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, realm_id integer NOT NULL, number integer NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', owner_id integer NOT NULL, assignee_id integer, state_id integer NOT NULL, substate_id integer, parent_id integer, rank text NOT NULL, labels text NOT NULL DEFAULT '[]', recurrence_id integer, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE labour_keys (key text PRIMARY KEY NOT NULL, labour_id integer NOT NULL, created_at integer NOT NULL);
CREATE TABLE comments (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, labour_id integer NOT NULL, author_id integer NOT NULL, body text NOT NULL, via text, created_at integer NOT NULL, updated_at integer);
CREATE TABLE events (seq integer PRIMARY KEY AUTOINCREMENT NOT NULL, type text NOT NULL, actor_id integer NOT NULL, token_id integer, token_name text, created_at integer NOT NULL, data text NOT NULL);
CREATE TABLE scrolls (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, realm_id integer NOT NULL, parent_id integer, slug text NOT NULL, path text NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '', rank text NOT NULL, version integer NOT NULL DEFAULT 1, created_by_id integer NOT NULL, updated_by_id integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE scroll_paths (realm_id integer NOT NULL, path text NOT NULL, scroll_id integer NOT NULL, created_at integer NOT NULL, PRIMARY KEY (realm_id, path));
CREATE TABLE labour_vectors (labour_id integer PRIMARY KEY NOT NULL, model text NOT NULL, vector blob NOT NULL, input_hash text NOT NULL, embedded_at integer NOT NULL);
CREATE TABLE attributes (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, realm_id integer NOT NULL, key text NOT NULL, kind text NOT NULL, label text NOT NULL, rubric text NOT NULL, spec text NOT NULL, position integer NOT NULL, created_at integer NOT NULL, revised_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE webhooks (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, owner_id integer NOT NULL, name text NOT NULL, url text NOT NULL, event_types text, realm_ids text, status text NOT NULL DEFAULT 'active', status_reason text, cursor integer NOT NULL, secret text NOT NULL, previous_secret text, previous_secret_expires_at integer, failing_since integer, attempts integer NOT NULL DEFAULT 0, next_attempt_at integer, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE VIRTUAL TABLE labour_text USING fts5(title, brief, description, comments, notes, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE scroll_text USING fts5(title, body, tokenize = 'porter unicode61');
CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric);
`;

const VECTOR = Buffer.alloc(1536, 7);
let made = 0;

function legacyDatabase(
	file: string,
	mutate: (sqlite: Database.Database) => void = () => {}
): Buffer {
	const sqlite = new Database(file);
	sqlite.exec(LEGACY_DDL);
	const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
	for (let i = 1; i <= LEGACY_LEVEL; i++)
		run('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)', `h${i}`, i);
	run('INSERT INTO users VALUES (1, ?, 1, ?, ?, ?, 0, 1000)', 'human', 'ada', 'Ada', 'hash');
	run('INSERT INTO users VALUES (7, ?, 0, ?, ?, NULL, 0, 1000)', 'agent', 'robo', 'Robo');
	run(
		'INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (4, 1, ?, ?, 1000)',
		'ci',
		'tokenhash'
	);
	run('INSERT INTO sessions VALUES (?, 1, 1000, 99999999999999)', 'sess');
	run('INSERT INTO realms VALUES (3, ?, ?, 2, 5)', 'Amber', 'AM');
	run('INSERT INTO realm_keys VALUES (?, 3, 1000), (?, 3, 900)', 'AM', 'OLD');
	run('INSERT INTO realm_members VALUES (3, 1, ?, ?, NULL, 1000, 1000)', 'owner', 'active');
	run(
		'INSERT INTO states VALUES (5, 3, ?, ?, ?, ?, 0, 0, 1, NULL), (6, 3, ?, ?, ?, ?, 1, 1, 0, NULL)',
		'todo',
		'To do',
		'#111111',
		'circle',
		'closed',
		'Closed',
		'#222222',
		'check'
	);
	run(
		'INSERT INTO labours VALUES (11, 3, 1, ?, ?, 1, 7, 5, NULL, NULL, ?, ?, NULL, 2000, 3000)',
		'Telegraph the slam',
		'wind-up for bosses',
		'a0',
		'["bug","wayfinder:map"]'
	);
	run(
		'INSERT INTO labours VALUES (12, 3, 2, ?, ?, 1, NULL, 6, NULL, 11, ?, ?, NULL, 2100, 3100)',
		'Closed one',
		'',
		'a1',
		'[]'
	);
	run(
		'INSERT INTO labour_keys VALUES (?, 11, 2000), (?, 12, 2100), (?, 11, 1500)',
		'AM-1',
		'AM-2',
		'OLD-9'
	);
	run('INSERT INTO comments VALUES (1, 11, 1, ?, NULL, 2500, NULL)', 'see the boss wind-ups');
	run(
		'INSERT INTO events VALUES (40, ?, 1, NULL, NULL, 2000, ?), (41, ?, 1, 4, ?, 2100, ?)',
		'labour.created',
		'{"labour":{"id":11}}',
		'labour.updated',
		'ci',
		'{"labour":{"id":11},"nested":{"b":1,"a":2}}'
	);
	run("UPDATE sqlite_sequence SET seq = 60 WHERE name = 'events'");
	run(
		'INSERT INTO scrolls VALUES (21, 3, NULL, ?, ?, ?, ?, ?, 1, 1, 1, 4000, 4000)',
		'release',
		'release',
		'Release process',
		'Tag the release',
		'a0'
	);
	run('INSERT INTO scroll_paths VALUES (3, ?, 21, 4000)', 'release');
	run('INSERT INTO labour_vectors VALUES (11, ?, ?, ?, 5000)', 'model', VECTOR, 'hash');
	run(
		'INSERT INTO attributes VALUES (1, 3, ?, ?, ?, ?, ?, 0, 1, 1, 1)',
		'impact',
		'scale',
		'Impact',
		'how much',
		'{"min":0,"max":4}'
	);
	run(
		'INSERT INTO labour_text (rowid, title, brief, description, comments, notes) VALUES (11, ?, ?, ?, ?, ?)',
		'stale',
		'',
		'',
		'',
		''
	);
	run(
		'INSERT INTO webhooks VALUES (1, 1, ?, ?, NULL, ?, ?, NULL, 41, ?, NULL, NULL, NULL, 0, NULL, 1, 1)',
		'hook',
		'https://example.test/h',
		'[3]',
		'paused',
		'sealed'
	);
	mutate(sqlite);
	sqlite.close();
	return readFileSync(file);
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function legacyBundle(
	root: string,
	options: {
		mutate?: (sqlite: Database.Database) => void;
		schema?: Manifest['schema'];
		attachments?: Record<string, string>;
		corrupt?: boolean;
	} = {}
): Promise<string> {
	const stem = `${++made}`;
	let database = legacyDatabase(join(root, `source-${stem}.db`), options.mutate);
	if (options.corrupt) database = Buffer.alloc(database.length, 9);
	const attachments = options.attachments ?? {};
	const files = [
		{ path: 'db/sagas.db', data: database },
		...Object.entries(attachments).map(([path, text]) => ({
			path: `attachments/${path}`,
			data: Buffer.from(text)
		}))
	];
	const manifest: Manifest & { skipped: unknown[]; remoteAttachments: unknown[] } = {
		format: 1,
		appVersion: '0.1.0',
		createdAt: '2026-11-06T19:25:57.445Z',
		schema: options.schema ?? { level: LEGACY_LEVEL, latest: 1793672276639 },
		files: files.map((file) => ({
			path: file.path,
			size: file.data.length,
			sha256: sha(file.data)
		})),
		skipped: [],
		remoteAttachments: []
	};
	const entries: ZipEntry[] = [
		...files.map((file) => ({ name: file.path, data: file.data })),
		{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }
	];
	const bundle = join(root, `legacy-${stem}.zip`);
	await pipeline(Readable.from(zipChunks(entries)), createWriteStream(bundle));
	return bundle;
}

let root: string;
let db: Db;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'sagas-legacy-'));
	db = await testDb();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const rows = async <T extends Record<string, unknown>>(sql: string, ...args: unknown[]) =>
	(await db.$client.query<T>(sql, args)).rows;

describe('a bundle from the SQLite build', () => {
	it('imports every table with its ids, keys and aliases', async () => {
		const result = await importBundle(db, await legacyBundle(root), LIMITS);

		expect(result.format).toBe(1);
		expect(result.rows).toMatchObject({
			users: 2,
			sessions: 1,
			api_tokens: 1,
			realms: 1,
			states: 2,
			labours: 2,
			labour_keys: 3,
			comments: 1,
			events: 2,
			scrolls: 1,
			labour_vectors: 1,
			attributes: 1,
			webhooks: 1
		});
		expect(
			(await rows('SELECT id, username FROM sagas_users ORDER BY id')).map((r) => [
				r.id,
				r.username
			])
		).toEqual([
			[1, 'ada'],
			[7, 'robo']
		]);
		expect(
			(await rows('SELECT key, labour_id FROM sagas_labour_keys ORDER BY key')).map((r) => [
				r.key,
				r.labour_id
			])
		).toEqual([
			['AM-1', 11],
			['AM-2', 12],
			['OLD-9', 11]
		]);
		expect((await rows('SELECT key FROM sagas_realm_keys ORDER BY key')).map((r) => r.key)).toEqual(
			['AM', 'OLD']
		);
	});

	it('converts booleans, JSON text and blobs', async () => {
		await importBundle(db, await legacyBundle(root), LIMITS);

		const admin = (
			await rows<{ is_admin: boolean }>('SELECT is_admin FROM sagas_users WHERE id = 1')
		)[0];
		expect(admin.is_admin).toBe(true);
		const states = await rows<{ is_closed: boolean; is_open: boolean }>(
			'SELECT is_closed, is_open FROM sagas_states ORDER BY id'
		);
		expect(states).toEqual([
			{ is_closed: false, is_open: true },
			{ is_closed: true, is_open: false }
		]);
		const labels = await rows('SELECT id FROM sagas_labours WHERE labels @> \'["bug"]\'::jsonb');
		expect(labels.map((r) => r.id)).toEqual([11]);
		const data = (
			await rows<{ data: unknown }>('SELECT data::text AS data FROM sagas_events WHERE seq = 41')
		)[0];
		expect(JSON.parse(data.data as string)).toEqual({ labour: { id: 11 }, nested: { b: 1, a: 2 } });
		const vector = (await rows<{ vector: Buffer }>('SELECT vector FROM sagas_labour_vectors'))[0]
			.vector;
		expect(vector.equals(VECTOR)).toBe(true);
		expect(
			(await rows<{ created_at: number }>('SELECT created_at FROM sagas_labours WHERE id = 11'))[0]
				.created_at
		).toBe(2000);
	});

	it('rebuilds the search index instead of trusting the FTS5 tables', async () => {
		await importBundle(db, await legacyBundle(root), LIMITS);

		expect([...(await keywordScores(db, 'telegraph')).keys()]).toEqual([11]);
		expect([...(await keywordScores(db, 'wind-ups')).keys()].sort()).toEqual([11]);
		expect((await keywordScores(db, 'stale')).size).toBe(0);
		expect(
			(
				await rows(
					"SELECT 1 FROM sagas_scroll_text WHERE search @@ plainto_tsquery('sagas_english', 'tag')"
				)
			).length
		).toBe(1);
	});

	it('lists through the app queries and continues every sequence', async () => {
		await importBundle(db, await legacyBundle(root), LIMITS);

		const page = await queryLabours(db, {}, { offset: 0, limit: 10 });
		expect(page.total).toBe(2);
		const actor = { id: 1 };
		const made = await createLabour(db, actor, { realmId: 3, title: 'new', ownerId: 1 });
		expect(made.id).toBe(13);
		expect(made.key).toBe('AM-3');
		const scroll = await createScroll(db, actor, { realmId: 3, title: 'second', body: '' });
		expect(scroll.id).toBe(22);
		const comment = await rows<{ id: number }>(
			`INSERT INTO sagas_comments (labour_id, author_id, body, created_at) VALUES (11, 1, 'x', 1) RETURNING id`
		);
		expect(comment[0].id).toBe(2);
		const user = await rows<{ id: number }>(
			`INSERT INTO sagas_users (kind, username, display_name, created_at) VALUES ('agent', 'next', 'Next', 1) RETURNING id`
		);
		expect(user[0].id).toBe(8);
	});

	it('continues the event seq from the old sqlite_sequence, not from the largest row', async () => {
		await importBundle(db, await legacyBundle(root), LIMITS);

		expect((await eventWindow(db)).last).toBe(60);
		const made = await createLabour(db, { id: 1 }, { realmId: 3, title: 'new', ownerId: 1 });
		void made;
		const last = (await rows<{ seq: number }>('SELECT max(seq) AS seq FROM sagas_events'))[0].seq;
		expect(last).toBe(61);
	});

	it('reports the attachment files it does not carry', async () => {
		const bundle = await legacyBundle(root, {
			attachments: { 'a.txt': 'abc', 'dir/b.bin': 'def' }
		});

		const result = await importBundle(db, bundle, LIMITS);

		expect(result.ignoredFiles).toBe(2);
	});

	it('imports an older schema level, whose tables and columns lack what this build added', async () => {
		const bundle = await legacyBundle(root, {
			schema: { level: 12, latest: 1 },
			mutate: (sqlite) => {
				sqlite.exec(
					'DROP TABLE webhooks; DROP TABLE attributes; DROP TABLE scroll_paths; DROP TABLE scrolls;'
				);
			}
		});

		const result = await importBundle(db, bundle, LIMITS);

		expect(result.rows.labours).toBe(2);
		expect(result.rows.webhooks).toBeUndefined();
		expect((await rows('SELECT 1 FROM sagas_scrolls')).length).toBe(0);
	});

	it('refuses a bundle claiming a newer schema level than the last SQLite migration', async () => {
		const bundle = await legacyBundle(root, { schema: { level: LEGACY_LEVEL + 1, latest: 1 } });

		await expect(importBundle(db, bundle, LIMITS)).rejects.toThrow(/newer than this build/);
	});

	it('refuses a database that is not SQLite and leaves the data untouched', async () => {
		await importBundle(db, await legacyBundle(root), LIMITS);
		const bundle = await legacyBundle(root, { corrupt: true });

		await expect(importBundle(db, bundle, LIMITS)).rejects.toThrow(/SQLite|damaged|readable/);
		expect((await rows('SELECT 1 FROM sagas_labours')).length).toBe(2);
	});

	it('rolls the whole import back when a row breaks a rule', async () => {
		await importBundle(db, await legacyBundle(root), LIMITS);
		const bundle = await legacyBundle(root, {
			mutate: (sqlite) => sqlite.exec("UPDATE realms SET key = 'lower'")
		});

		await expect(importBundle(db, bundle, LIMITS)).rejects.toBeInstanceOf(BundleError);
		expect((await rows<{ key: string }>('SELECT key FROM sagas_realms'))[0].key).toBe('AM');
	});

	it('refuses a row that points at a missing parent', async () => {
		const bundle = await legacyBundle(root, {
			mutate: (sqlite) => sqlite.exec('UPDATE labours SET owner_id = 99 WHERE id = 12')
		});

		await expect(importBundle(db, bundle, LIMITS)).rejects.toBeInstanceOf(BundleError);
		expect((await rows('SELECT 1 FROM sagas_labours')).length).toBe(0);
	});
});
