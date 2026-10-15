import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour, seedUser } from '#lib/server/test/fixtures.ts';
import { addQuestLabour, createQuest } from './quests.ts';
import { createState, listStates, moveState } from './states.ts';
import { queryLabours, type LabourFilter } from './labour-query.ts';
import { rankLabour, setParent, updateLabour } from './labours.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

const all = { offset: 0, limit: 100 };
const keys = (filter: LabourFilter, page = all) =>
	queryLabours(db, filter, page).labours.map((t) => t.key);

describe('queryLabours', () => {
	it('orders by Realm, then State position, then Rank', () => {
		const am = seedRealm(db, 'AM');
		const ops = seedRealm(db, 'OPS');
		const actor = seedActor(db);
		const [todo, closed] = listStates(db, am.id);
		const doing = createState(db, actor, am.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		moveState(db, actor, doing.id, 0);
		const done = seedLabour(db, { realmId: am.id });
		seedLabour(db, { realmId: am.id });
		seedLabour(db, { realmId: ops.id });
		const t3 = seedLabour(db, { realmId: am.id });
		const t4 = seedLabour(db, { realmId: am.id });
		updateLabour(db, actor, done.id, { stateId: closed.id });
		updateLabour(db, actor, t4.id, { stateId: doing.id });
		rankLabour(db, actor, t3.id, 'top');

		const byPosition = listStates(db, am.id).map((s) => s.id);
		expect(byPosition).toEqual([doing.id, todo.id, closed.id]);
		expect(byPosition.toSorted((a, b) => a - b)).not.toEqual(byPosition);
		expect(keys({})).toEqual(['AM-4', 'AM-3', 'AM-2', 'AM-1', 'OPS-1']);
	});

	it('filters by State, owner, assignee, Parent and closed', () => {
		const am = seedRealm(db, 'AM');
		const actor = seedActor(db);
		const ada = seedUser(db, 'ada');
		const closed = listStates(db, am.id).find((s) => s.isClosed)!;
		const parent = seedLabour(db, { realmId: am.id, ownerId: ada });
		const child = seedLabour(db, { realmId: am.id, assigneeId: ada });
		setParent(db, actor, child.id, parent.id);
		updateLabour(db, actor, parent.id, { stateId: closed.id });

		expect(keys({ ownerId: ada })).toEqual(['AM-1']);
		expect(keys({ assigneeId: ada })).toEqual(['AM-2']);
		expect(keys({ assigneeId: null })).toEqual(['AM-1']);
		expect(keys({ parentId: parent.id })).toEqual(['AM-2']);
		expect(keys({ parentId: null })).toEqual(['AM-1']);
		expect(keys({ closed: true })).toEqual(['AM-1']);
		expect(keys({ closed: false, realmId: am.id })).toEqual(['AM-2']);
		expect(keys({ stateId: closed.id })).toEqual(['AM-1']);
	});

	it('lists a Quest in Quest order', () => {
		const am = seedRealm(db, 'AM');
		const actor = seedActor(db);
		const quest = createQuest(db, actor, { name: 'Q', ownerId: seedUser(db) });
		const [a, b] = [seedLabour(db, { realmId: am.id }), seedLabour(db, { realmId: am.id })];
		seedLabour(db, { realmId: am.id });
		addQuestLabour(db, actor, quest.id, a.id);
		addQuestLabour(db, actor, quest.id, b.id, 'top');

		expect(keys({ questId: quest.id })).toEqual(['AM-2', 'AM-1']);
		expect(queryLabours(db, { questId: quest.id }, all).total).toBe(2);
	});

	it('pages in Rank order with offset and limit, and counts every match', () => {
		const am = seedRealm(db, 'AM');
		const actor = seedActor(db);
		const made = [1, 2, 3, 4, 5].map(() => seedLabour(db, { realmId: am.id }));
		rankLabour(db, actor, made[4].id, 'top');
		rankLabour(db, actor, made[3].id, 'top');

		expect(keys({ realmId: am.id })).toEqual(['AM-4', 'AM-5', 'AM-1', 'AM-2', 'AM-3']);
		const page = queryLabours(db, { realmId: am.id }, { offset: 2, limit: 2 });

		expect(page.labours.map((t) => t.key)).toEqual(['AM-1', 'AM-2']);
		expect(page.total).toBe(5);
	});

	it('filters by Labels, requiring every one', () => {
		const realm = seedRealm(db, 'AM');
		const actor = seedActor(db);
		seedLabour(db, { realmId: realm.id, labels: ['wayfinder:map'] });
		seedLabour(db, { realmId: realm.id, labels: ['wayfinder:grilling', 'bug'] });
		seedLabour(db, { realmId: realm.id });
		const third = seedLabour(db, { realmId: realm.id });
		updateLabour(db, actor, third.id, { addLabels: ['bug'] });

		expect(keys({ labels: ['wayfinder:map'] })).toEqual(['AM-1']);
		expect(keys({ labels: ['bug'] })).toEqual(['AM-2', 'AM-4']);
		expect(keys({ labels: ['bug', 'wayfinder:grilling'] })).toEqual(['AM-2']);
		expect(keys({ labels: ['wayfinder'] })).toEqual([]);
		expect(queryLabours(db, { labels: ['bug'] }, { offset: 0, limit: 1 }).total).toBe(2);
	});
});
