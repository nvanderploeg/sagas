import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const NOW = new Date('2026-03-01T12:00:00.000Z');

// A loader reads only rows tied to the candidates: a scan of one of these reads every row.
const GUARDED = ['sagas_mentions', 'sagas_comments', 'sagas_links', 'sagas_quest_labours'];

type Captured = { source: string };

// The SELECTs the pool's clients send while `run` runs.
async function capture(run: () => Promise<unknown>): Promise<Captured[]> {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	try {
		await run();
		return spy.mock.calls.flatMap(([first]) => {
			const source = typeof first === 'string' ? first : (first as { text?: string })?.text;
			return source !== undefined && /^\s*(select|with)\b/i.test(source) ? [{ source }] : [];
		});
	} finally {
		spy.mockRestore();
	}
}

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };

function seqScans(node: PlanNode): string[] {
	const own =
		node['Node Type'] === 'Seq Scan' && node['Relation Name'] !== undefined
			? [node['Relation Name']]
			: [];
	return [...own, ...(node.Plans ?? []).flatMap(seqScans)];
}

// With sequential scans priced out, one left in the generic plan has no index to use.
async function scans({ source }: Captured): Promise<string[]> {
	const client = await db.$client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL enable_seqscan = off');
		const { rows } = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
			`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${source}`
		);
		return seqScans(rows[0]['QUERY PLAN'][0].Plan).filter((table) => GUARDED.includes(table));
	} finally {
		await client.query('ROLLBACK');
		client.release();
	}
}

async function seed() {
	const realm = await seedRealm(db, 'AM');
	const labours = await Promise.all(
		[1, 2, 3].map((n) => seedLabour(db, { realmId: realm.id, title: `Labour ${n}` }))
	);
	const [a, b, c] = labours;
	await appraise(db, actor, [
		{
			labourId: a.id,
			links: [
				{ type: 'evidence', to: b.id },
				{ type: 'blocks', to: c.id }
			]
		}
	]);
	await addComment(db, actor, b.id, `see ${a.key}`);
	const quest = await createQuest(db, actor, { realmId: realm.id, name: 'Q', ownerId: actor.id });
	await addQuestLabours(db, actor, quest.id, [a.id, b.id, c.id]);
}

describe('Survey loaders', () => {
	it.each(Object.values(FEATURES).map((feature) => [feature.name, feature.needsQuery ?? false]))(
		'%s reads no whole table',
		async (name, needsQuery) => {
			await seed();
			const statements = await capture(async () => {
				await survey(
					db,
					actor,
					{ weights: { [name as string]: 1 }, query: needsQuery ? 'labour' : undefined },
					{ now: NOW }
				);
			});
			expect((await Promise.all(statements.map(scans))).flat()).toEqual([]);
		}
	);
});
