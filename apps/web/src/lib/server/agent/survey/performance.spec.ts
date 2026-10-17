import { generateNKeysBetween } from 'fractional-indexing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appraise, type AppraiseItem } from '#lib/server/agent/appraisals.ts';
import { defineAttribute } from '#lib/server/agent/attributes.ts';
import { contentHash } from '#lib/server/agent/content.ts';
import { rebuildDerived } from '#lib/server/agent/derived.ts';
import { survey } from '#lib/server/agent/survey/index.ts';
import type { Db } from '#lib/server/db/client.ts';
import { comments, derivedBuilds, labourKeys, labours, mentions } from '#lib/server/db/schema.ts';
import { addQuestLabours, createQuest } from '#lib/server/domain/quests.ts';
import { createState, listStates } from '#lib/server/domain/states.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { budget } from '#lib/server/test/budget.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');

const OPEN_AM = 3000;
const CLOSED_AM = 100;
const OPEN_BL = 2000;

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

// 5,000 open Labours across two Realms and two columns each, plus 100 Closed ones, with
// Attribute values, Links, Quests, Comments and Mentions on them.
function seed() {
	const owner = seedUser(db, 'owner');
	const realmRows = [seedRealm(db, 'AM'), seedRealm(db, 'BL')];
	const plan: { realmId: number; number: number; stateId: number }[] = [];
	const columns = new Map<number, number>();
	for (const [realm, open, shut] of [
		[realmRows[0], OPEN_AM, CLOSED_AM],
		[realmRows[1], OPEN_BL, 0]
	] as const) {
		createState(db, actor, realm.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		const states = listStates(db, realm.id);
		const todo = states.find((s) => s.key === 'todo')!;
		const doing = states.find((s) => s.key === 'doing')!;
		const closed = states.find((s) => s.isClosed)!;
		for (let n = 1; n <= open + shut; n++) {
			const state = n > open ? closed : n % 2 === 0 ? doing : todo;
			plan.push({ realmId: realm.id, number: n, stateId: state.id });
			columns.set(state.id, (columns.get(state.id) ?? 0) + 1);
		}
	}
	const ranks = new Map<number, string[]>(
		[...columns].map(([stateId, count]) => [stateId, generateNKeysBetween(null, null, count)])
	);
	const taken = new Map<number, number>();
	const rows = plan.map((p) => {
		const at = taken.get(p.stateId) ?? 0;
		taken.set(p.stateId, at + 1);
		const created = new Date(NOW.getTime() - (p.number % 100) * DAY);
		return {
			realmId: p.realmId,
			number: p.number,
			title: `Labour ${p.number} ${p.number % 5 === 0 ? 'boss fight' : 'chore'}`,
			description: p.number % 3 === 0 ? 'The boss arena needs another lighting pass.' : '',
			ownerId: owner,
			stateId: p.stateId,
			rank: ranks.get(p.stateId)![at],
			labels: [] as string[],
			createdAt: created,
			updatedAt: created
		};
	});
	const keyOfRealm = new Map(realmRows.map((r) => [r.id, r.key]));

	db.transaction((tx) => {
		for (const part of chunks(rows, 500)) tx.insert(labours).values(part).run();
	});
	const ids = db
		.select({ id: labours.id })
		.from(labours)
		.orderBy(labours.id)
		.all()
		.map((r) => r.id);
	db.transaction((tx) => {
		const keys = rows.map((row, i) => ({
			key: `${keyOfRealm.get(row.realmId)}-${row.number}`,
			labourId: ids[i]
		}));
		for (const part of chunks(keys, 500)) tx.insert(labourKeys).values(part).run();
		const talk = ids
			.filter((_, i) => i % 2 === 0)
			.map((labourId, i) => ({
				labourId,
				authorId: actor.id,
				body: `Comment ${i} about the boss fight`,
				createdAt: new Date(NOW.getTime() - (i % 50) * DAY)
			}));
		for (const part of chunks(talk, 500)) tx.insert(comments).values(part).run();
	});
	for (const realm of realmRows) {
		db.$client
			.prepare('UPDATE realms SET labour_counter = ? WHERE id = ?')
			.run(rows.filter((r) => r.realmId === realm.id).length, realm.id);
	}

	// The bulk rows bypass the writes that keep the search index, so build it whole.
	db.delete(derivedBuilds).run();
	rebuildDerived(db);

	for (const realm of realmRows) {
		defineAttribute(db, actor, realm.id, {
			key: 'impact',
			kind: 'scale',
			label: 'Impact',
			rubric: 'How much players feel it',
			spec: { min: 1, max: 5 }
		});
		defineAttribute(db, actor, realm.id, {
			key: 'area',
			kind: 'tags',
			label: 'Area',
			rubric: 'Where it lives',
			spec: {
				members: [
					{ key: 'ui', label: 'UI' },
					{ key: 'api', label: 'API' }
				]
			}
		});
	}
	const items: AppraiseItem[] = ids.map((labourId, k) => {
		const item: AppraiseItem = {
			labourId,
			values: { impact: 1 + (k % 5), area: k % 3 === 0 ? ['ui'] : ['api'] },
			links: []
		};
		if (k % 7 === 0) item.brief = `Brief for the boss fight ${k}`;
		if (k % 5 === 0) item.stamp = contentHash(db, labourId);
		if (k % 3 === 0 && k + 1 < ids.length) {
			item.links!.push({ type: 'evidence', to: ids[k + 1] });
		}
		if (k % 11 === 0 && k + 7 < ids.length) item.links!.push({ type: 'blocks', to: ids[k + 7] });
		return item;
	});
	for (const part of chunks(items, 50)) appraise(db, actor, part, NOW);

	for (const [q, members] of chunks(ids, 100).entries()) {
		const quest = createQuest(db, actor, { name: `Quest ${q}`, ownerId: owner });
		addQuestLabours(db, actor, quest.id, members);
	}

	db.transaction((tx) => {
		const rowsOut = ids
			.filter((_, i) => i % 4 === 0)
			.flatMap((sourceLabourId, i) => {
				const target = ids[(i * 4 + 3) % ids.length];
				const named =
					target === sourceLabourId
						? []
						: [
								{
									sourceLabourId,
									labourId: target,
									commentId: null,
									authorId: actor.id,
									firstSeenAt: new Date(NOW.getTime() - (i % 30) * DAY)
								}
							];
				const pulled =
					i % 3 === 0
						? [
								{
									sourceLabourId,
									userId: actor.id,
									commentId: null,
									authorId: owner,
									firstSeenAt: new Date(NOW.getTime() - (i % 20) * DAY)
								}
							]
						: [];
				return [...named, ...pulled];
			});
		for (const part of chunks(rowsOut, 500)) tx.insert(mentions).values(part).run();
	});
}

describe('survey performance', () => {
	it('scores 5,000 candidates with every feature, an Attribute weight and a query in under 200 ms', () => {
		seed();
		const weights = {
			keywords: 1,
			mentions: 1,
			pulled_in: 1,
			evidence: 1,
			unblocks: 1,
			quest_finish: 1,
			column: 1,
			age: 1,
			activity: 1,
			impact: 1,
			'area:ui': 1
		};
		const run = () =>
			survey(
				db,
				actor,
				{ weights, query: 'boss fight', limit: 15, show: ['impact'] },
				{ now: NOW }
			);

		const warm = run();
		const times: number[] = [];
		for (let i = 0; i < 3; i++) {
			const start = performance.now();
			run();
			times.push(performance.now() - start);
		}

		expect(OPEN_AM + OPEN_BL).toBe(5000);
		expect(warm.results).toHaveLength(15);
		expect(warm.ignored).toEqual([]);
		// Every fifth Labour is stamped, and none has changed since.
		expect(warm.coverage).toEqual({
			candidates: 5000,
			unappraised: 4000,
			stale: 0,
			unembedded: 5000,
			missing: {}
		});
		expect(times.sort((a, b) => a - b)[1]).toBeLessThan(budget(200));
	}, 120_000);
});
