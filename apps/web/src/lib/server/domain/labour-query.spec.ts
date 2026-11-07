import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import {
	seedActor,
	seedRealm,
	seedLabour,
	seedUser,
	anyRealmId
} from '#lib/server/test/fixtures.ts';
import { addQuestLabour, createQuest } from './quests.ts';
import { createState, listStates, moveState, updateState } from './states.ts';
import { queryLabours, type LabourFilter } from './labour-query.ts';
import { rankLabour, setParent, updateLabour } from './labours.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

const all = { offset: 0, limit: 100 };
const keys = async (filter: LabourFilter, page = all) =>
	(await queryLabours(db, filter, page)).labours.map((t) => t.key);

describe('queryLabours', () => {
	it('orders by Realm, then State position, then Rank', async () => {
		const am = await seedRealm(db, 'AM');
		const ops = await seedRealm(db, 'OPS');
		const actor = await seedActor(db);
		const [todo, closed] = await listStates(db, am.id);
		const doing = await createState(db, actor, am.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		await moveState(db, actor, doing.id, 0);
		const done = await seedLabour(db, { realmId: am.id });
		await seedLabour(db, { realmId: am.id });
		await seedLabour(db, { realmId: ops.id });
		const t3 = await seedLabour(db, { realmId: am.id });
		const t4 = await seedLabour(db, { realmId: am.id });
		await updateLabour(db, actor, done.id, { stateId: closed.id });
		await updateLabour(db, actor, t4.id, { stateId: doing.id });
		await rankLabour(db, actor, t3.id, 'top');

		const byPosition = (await listStates(db, am.id)).map((s) => s.id);
		expect(byPosition).toEqual([doing.id, todo.id, closed.id]);
		expect(byPosition.toSorted((a, b) => a - b)).not.toEqual(byPosition);
		expect(await keys({})).toEqual(['AM-4', 'AM-3', 'AM-2', 'AM-1', 'OPS-1']);
	});

	it('filters by State, owner, assignee, Parent and closed', async () => {
		const am = await seedRealm(db, 'AM');
		const actor = await seedActor(db);
		const ada = await seedUser(db, 'ada');
		const closed = (await listStates(db, am.id)).find((s) => s.isClosed)!;
		const parent = await seedLabour(db, { realmId: am.id, ownerId: ada });
		const child = await seedLabour(db, { realmId: am.id, assigneeId: ada });
		await setParent(db, actor, child.id, parent.id);
		await updateLabour(db, actor, parent.id, { stateId: closed.id });

		expect(await keys({ ownerId: ada })).toEqual(['AM-1']);
		expect(await keys({ assigneeId: ada })).toEqual(['AM-2']);
		expect(await keys({ assigneeId: null })).toEqual(['AM-1']);
		expect(await keys({ parentId: parent.id })).toEqual(['AM-2']);
		expect(await keys({ parentId: null })).toEqual(['AM-1']);
		expect(await keys({ closed: true })).toEqual(['AM-1']);
		expect(await keys({ closed: false, realmId: am.id })).toEqual(['AM-2']);
		expect(await keys({ stateId: closed.id })).toEqual(['AM-1']);
	});

	it('filters by whether the State is open', async () => {
		const am = await seedRealm(db, 'AM');
		const actor = await seedActor(db);
		const [, closed] = await listStates(db, am.id);
		const backlog = await createState(db, actor, am.id, {
			key: 'backlog',
			label: 'Backlog',
			color: '#000000',
			icon: 'dot'
		});
		await updateState(db, actor, backlog.id, { open: false });
		const ready = await seedLabour(db, { realmId: am.id });
		const groom = await seedLabour(db, { realmId: am.id });
		const done = await seedLabour(db, { realmId: am.id });
		await updateLabour(db, actor, groom.id, { stateId: backlog.id });
		await updateLabour(db, actor, done.id, { stateId: closed.id });

		expect(await keys({ open: true })).toEqual([ready.key]);
		expect(await keys({ open: false })).toEqual([groom.key, done.key]);
	});

	it('lists a Quest in Quest order', async () => {
		const am = await seedRealm(db, 'AM');
		const actor = await seedActor(db);
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Q',
			ownerId: await seedUser(db)
		});
		const [a, b] = [
			await seedLabour(db, { realmId: am.id }),
			await seedLabour(db, { realmId: am.id })
		];
		await seedLabour(db, { realmId: am.id });
		await addQuestLabour(db, actor, quest.id, a.id);
		await addQuestLabour(db, actor, quest.id, b.id, 'top');

		expect(await keys({ questId: quest.id })).toEqual(['AM-2', 'AM-1']);
		expect((await queryLabours(db, { questId: quest.id }, all)).total).toBe(2);
	});

	it('pages in Rank order with offset and limit, and counts every match', async () => {
		const am = await seedRealm(db, 'AM');
		const actor = await seedActor(db);
		const made = await Promise.all([1, 2, 3, 4, 5].map(() => seedLabour(db, { realmId: am.id })));
		await rankLabour(db, actor, made[4].id, 'top');
		await rankLabour(db, actor, made[3].id, 'top');

		expect(await keys({ realmId: am.id })).toEqual(['AM-4', 'AM-5', 'AM-1', 'AM-2', 'AM-3']);
		const page = await queryLabours(db, { realmId: am.id }, { offset: 2, limit: 2 });

		expect(page.labours.map((t) => t.key)).toEqual(['AM-1', 'AM-2']);
		expect(page.total).toBe(5);
	});

	it('filters by Labels, requiring every one', async () => {
		const realm = await seedRealm(db, 'AM');
		const actor = await seedActor(db);
		await seedLabour(db, { realmId: realm.id, labels: ['wayfinder:map'] });
		await seedLabour(db, { realmId: realm.id, labels: ['wayfinder:grilling', 'bug'] });
		await seedLabour(db, { realmId: realm.id });
		const third = await seedLabour(db, { realmId: realm.id });
		await updateLabour(db, actor, third.id, { addLabels: ['bug'] });

		expect(await keys({ labels: ['wayfinder:map'] })).toEqual(['AM-1']);
		expect(await keys({ labels: ['bug'] })).toEqual(['AM-2', 'AM-4']);
		expect(await keys({ labels: ['bug', 'wayfinder:grilling'] })).toEqual(['AM-2']);
		expect(await keys({ labels: ['wayfinder'] })).toEqual([]);
		expect((await queryLabours(db, { labels: ['bug'] }, { offset: 0, limit: 1 })).total).toBe(2);
	});
});
