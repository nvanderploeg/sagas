import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { survey } from '#lib/server/agent/survey/index.ts';
import { FEATURES } from '#lib/server/agent/survey/features/index.ts';
import type { Db } from '#lib/server/db/client.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { addQuestLabours, createQuest } from '#lib/server/domain/quests.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const NOW = new Date('2026-03-01T12:00:00.000Z');

// A loader reads only rows tied to the candidates: a scan of one of these reads every row.
const GUARDED = ['mentions', 'comments', 'links', 'quest_labours'];

type Captured = { source: string; args: unknown[] };

function capture(run: () => void): Captured[] {
	const client = db.$client;
	const prepare = client.prepare.bind(client);
	const seen: Captured[] = [];
	client.prepare = ((source: string) => {
		const statement = prepare(source);
		return new Proxy(statement, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (typeof value !== 'function') return value;
				const bound = value.bind(target);
				if (key !== 'all' && key !== 'get' && key !== 'run' && key !== 'iterate') return bound;
				return (...args: unknown[]) => {
					seen.push({ source, args });
					return bound(...args);
				};
			}
		});
	}) as typeof client.prepare;
	try {
		run();
	} finally {
		client.prepare = prepare;
	}
	return seen;
}

const SQL_WORDS = new Set([
	'on',
	'where',
	'join',
	'cross',
	'left',
	'inner',
	'group',
	'order',
	'limit',
	'using'
]);

// Alias to table for every table a statement names, so `SCAN m` reads as `mentions`.
function tablesOf(source: string): Map<string, string> {
	const tables = new Map<string, string>();
	for (const m of source.matchAll(/\b(?:from|join)\s+"?(\w+)"?(?:\s+(?:as\s+)?"?(\w+)"?)?/gi)) {
		tables.set(m[1], m[1]);
		if (m[2] && !SQL_WORDS.has(m[2].toLowerCase())) tables.set(m[2], m[1]);
	}
	return tables;
}

function scans({ source, args }: Captured): string[] {
	const tables = tablesOf(source);
	const plan = db.$client.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...args) as {
		detail: string;
	}[];
	return plan
		.map((row) => /^SCAN "?(\w+)"?/.exec(row.detail)?.[1])
		.filter((name): name is string => name !== undefined)
		.map((name) => tables.get(name) ?? name)
		.filter((table) => GUARDED.includes(table));
}

function seed() {
	const realm = seedRealm(db, 'AM');
	const labours = [1, 2, 3].map((n) => seedLabour(db, { realmId: realm.id, title: `Labour ${n}` }));
	const [a, b, c] = labours;
	appraise(db, actor, [
		{
			labourId: a.id,
			links: [
				{ type: 'evidence', to: b.id },
				{ type: 'blocks', to: c.id }
			]
		}
	]);
	addComment(db, actor, b.id, `see ${a.key}`, NOW);
	const quest = createQuest(db, actor, { realmId: realm.id, name: 'Q', ownerId: actor.id });
	addQuestLabours(db, actor, quest.id, [a.id, b.id, c.id]);
}

describe('Survey loaders', () => {
	it.each(Object.values(FEATURES).map((feature) => [feature.name, feature.needsQuery ?? false]))(
		'%s reads no whole table',
		(name, needsQuery) => {
			seed();
			const statements = capture(() => {
				survey(
					db,
					actor,
					{ weights: { [name as string]: 1 }, query: needsQuery ? 'labour' : undefined },
					{ now: NOW }
				);
			});
			expect(statements.flatMap(scans)).toEqual([]);
		}
	);
});
