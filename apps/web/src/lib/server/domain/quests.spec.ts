import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { questLabours, labours } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import {
	seedActor,
	seedRealm,
	seedLabour,
	seedUser,
	anyRealmId
} from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	addQuestLabour,
	addQuestLabours,
	addQuestLabourWithChildren,
	createQuest,
	deleteQuest,
	listQuests,
	listQuestLabours,
	listLabourQuests,
	questProgress,
	rankQuestLabour,
	readQuest,
	removeQuestLabour,
	removeQuestLabours,
	updateQuest
} from './quests.ts';
import { listStates } from './states.ts';
import { deleteLabour, moveLabour, updateLabour } from './labours.ts';
import type { Actor } from './write.ts';

let db: Db;
let actor: Actor;
let ownerId: number;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	ownerId = await seedUser(db, 'ada');
});

async function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

const seedQuest = async (name = 'Launch') =>
	createQuest(db, actor, { realmId: await anyRealmId(db), name, ownerId });
const keys = async (questId: number) => (await listQuestLabours(db, questId)).map((t) => t.key);
const closedOf = async (realmId: number) =>
	(await listStates(db, realmId)).find((s) => s.isClosed)!;

describe('Quest CRUD', () => {
	it('creates a Quest with a name, description and Owner, and no Labours', async () => {
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: ' Launch ',
			description: 'Ship it',
			ownerId
		});

		expect(quest).toMatchObject({
			name: 'Launch',
			description: 'Ship it',
			ownerId,
			labours: [],
			progress: { closed: 0, total: 0 }
		});
		expect((await listQuests(db)).map((q) => q.id)).toEqual([quest.id]);
	});

	it('rejects a blank name and an Owner that does not exist', async () => {
		await expectDomainError(
			async () => createQuest(db, actor, { realmId: await anyRealmId(db), name: '  ', ownerId }),
			'invalid'
		);
		await expectDomainError(
			async () =>
				createQuest(db, actor, { realmId: await anyRealmId(db), name: 'x', ownerId: 999 }),
			'invalid'
		);
		expect(await listQuests(db)).toEqual([]);
	});

	it('updates the name, description and Owner', async () => {
		const quest = await seedQuest();
		const grace = await seedUser(db, 'grace');

		const updated = await updateQuest(db, actor, quest.id, {
			name: 'Relaunch',
			description: 'Again',
			ownerId: grace
		});

		expect(updated).toMatchObject({ name: 'Relaunch', description: 'Again', ownerId: grace });
	});

	it('deletes a Quest and leaves its Labours in place', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, labour.id);

		await deleteQuest(db, actor, quest.id);

		await expectDomainError(() => readQuest(db, quest.id), 'not_found');
		expect(await db.select().from(questLabours)).toEqual([]);
		expect(await db.select().from(labours)).toHaveLength(1);
	});
});

describe('membership', () => {
	it('holds Labours from any Realm, in the order they were added', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const a = await seedLabour(db, { realmId: am.id });
		const b = await seedLabour(db, { realmId: bl.id });
		const quest = await seedQuest();

		await addQuestLabour(db, actor, quest.id, b.id);
		await addQuestLabour(db, actor, quest.id, a.id);

		expect(await keys(quest.id)).toEqual(['BL-1', 'AM-1']);
		expect((await readQuest(db, quest.id)).labours.map((t) => t.id)).toEqual([b.id, a.id]);
	});

	it('lets one Labour sit in any number of Quests', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const first = await seedQuest('First');
		const second = await seedQuest('Second');

		await addQuestLabour(db, actor, first.id, labour.id);
		await addQuestLabour(db, actor, second.id, labour.id);

		expect((await listLabourQuests(db, labour.id)).map((q) => q.name)).toEqual(['First', 'Second']);
	});

	it('never adds a Labour Children with it', async () => {
		const realm = await seedRealm(db, 'AM');
		const parent = await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const quest = await seedQuest();

		await addQuestLabour(db, actor, quest.id, parent.id);

		expect((await readQuest(db, quest.id)).labours.map((t) => t.id)).toEqual([parent.id]);
	});

	it('adds the direct Children only through the explicit helper, right after the Labour', async () => {
		const realm = await seedRealm(db, 'AM');
		const first = await seedLabour(db, { realmId: realm.id });
		const parent = await seedLabour(db, { realmId: realm.id });
		const child = await seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const other = await seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const grandchild = await seedLabour(db, { realmId: realm.id, parentId: child.id });
		const last = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, first.id);
		await addQuestLabour(db, actor, quest.id, last.id);
		await addQuestLabour(db, actor, quest.id, other.id);

		const view = await addQuestLabourWithChildren(db, actor, quest.id, parent.id, {
			after: first.id
		});

		expect(view.labours.map((t) => t.id)).toEqual([
			first.id,
			parent.id,
			child.id,
			last.id,
			other.id
		]);
		expect(view.labours.map((t) => t.id)).not.toContain(grandchild.id);
		await expectDomainError(
			() => addQuestLabourWithChildren(db, actor, quest.id, parent.id),
			'conflict'
		);
	});

	it('refuses a Labour already in the Quest, and removing one that is not', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, labour.id);

		await expectDomainError(() => addQuestLabour(db, actor, quest.id, labour.id), 'conflict');
		await removeQuestLabour(db, actor, quest.id, labour.id);
		await expectDomainError(() => removeQuestLabour(db, actor, quest.id, labour.id), 'not_found');
		expect((await readQuest(db, quest.id)).labours.map((t) => t.id)).toEqual([]);
	});

	it('refuses an unknown Labour or Quest', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();

		await expectDomainError(() => addQuestLabour(db, actor, quest.id, 999), 'not_found');
		await expectDomainError(() => addQuestLabour(db, actor, 999, labour.id), 'not_found');
	});

	it('drops a deleted Labour from every Quest it was in', async () => {
		const realm = await seedRealm(db, 'AM');
		const gone = await seedLabour(db, { realmId: realm.id });
		const kept = await seedLabour(db, { realmId: realm.id });
		const first = await seedQuest('First');
		const second = await seedQuest('Second');
		for (const quest of [first, second]) {
			await addQuestLabour(db, actor, quest.id, gone.id);
			await addQuestLabour(db, actor, quest.id, kept.id);
		}

		await deleteLabour(db, actor, gone.id);

		expect((await readQuest(db, first.id)).labours.map((t) => t.id)).toEqual([kept.id]);
		expect((await readQuest(db, second.id)).labours.map((t) => t.id)).toEqual([kept.id]);
	});
});

describe('bulk membership', () => {
	const ids = async (questId: number) => (await readQuest(db, questId)).labours.map((t) => t.id);

	it('adds Labours in the order given, at the placement, skipping and reporting members', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b, c, d] = await Promise.all(
			[1, 2, 3, 4].map(() => seedLabour(db, { realmId: realm.id }))
		);
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, a.id);
		await addQuestLabour(db, actor, quest.id, b.id);

		const result = await addQuestLabours(db, actor, quest.id, [d.id, b.id, c.id, d.id], {
			after: a.id
		});

		expect(result.labourIds).toEqual([d.id, c.id]);
		expect(result.skipped).toEqual([b.id]);
		expect(result.quest.labours.map((t) => t.id)).toEqual([a.id, d.id, c.id, b.id]);
		expect(await ids(quest.id)).toEqual([a.id, d.id, c.id, b.id]);
	});

	it('is idempotent: adding members again changes nothing and reports them all', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b] = await Promise.all([1, 2].map(() => seedLabour(db, { realmId: realm.id })));
		const quest = await seedQuest();
		await addQuestLabours(db, actor, quest.id, [a.id, b.id]);

		const again = await addQuestLabours(db, actor, quest.id, [b.id, a.id], 'top');

		expect(again).toMatchObject({ labourIds: [], skipped: [b.id, a.id] });
		expect(await ids(quest.id)).toEqual([a.id, b.id]);
	});

	it('never adds Children', async () => {
		const realm = await seedRealm(db, 'AM');
		const parent = await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const quest = await seedQuest();

		await addQuestLabours(db, actor, quest.id, [parent.id]);

		expect(await ids(quest.id)).toEqual([parent.id]);
	});

	it('adds none when any Labour is unknown or the anchor is not a member', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b] = await Promise.all([1, 2].map(() => seedLabour(db, { realmId: realm.id })));
		const quest = await seedQuest();

		await expectDomainError(() => addQuestLabours(db, actor, quest.id, [a.id, 999]), 'not_found');
		await expectDomainError(
			() => addQuestLabours(db, actor, quest.id, [a.id], { before: b.id }),
			'invalid'
		);
		await expectDomainError(() => addQuestLabours(db, actor, 999, [a.id]), 'not_found');
		expect(await ids(quest.id)).toEqual([]);
	});

	it('names an anchor outside the Quest by its key', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b] = await Promise.all([1, 2].map(() => seedLabour(db, { realmId: realm.id })));
		const quest = await seedQuest();

		await expect(addQuestLabours(db, actor, quest.id, [a.id], { after: b.id })).rejects.toThrow(
			'AM-2 is not in the same Quest'
		);
	});

	it('removes Labours, skipping and reporting the ones not in the Quest', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => seedLabour(db, { realmId: realm.id })));
		const quest = await seedQuest();
		await addQuestLabours(db, actor, quest.id, [a.id, b.id]);

		const result = await removeQuestLabours(db, actor, quest.id, [c.id, b.id, a.id, b.id]);

		expect(result).toMatchObject({ labourIds: [b.id, a.id], skipped: [c.id] });
		expect(await ids(quest.id)).toEqual([]);
		expect(await removeQuestLabours(db, actor, quest.id, [a.id])).toMatchObject({
			labourIds: [],
			skipped: [a.id]
		});
	});

	it('removes none when any Labour is unknown', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, a.id);

		await expectDomainError(
			() => removeQuestLabours(db, actor, quest.id, [a.id, 999]),
			'not_found'
		);
		expect(await ids(quest.id)).toEqual([a.id]);
	});
});

describe('Quest order', () => {
	it('places a Labour at a position when added, and reorders within the Quest', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => seedLabour(db, { realmId: realm.id })));
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, a.id);
		await addQuestLabour(db, actor, quest.id, b.id);
		await addQuestLabour(db, actor, quest.id, c.id, 'top');
		expect(await keys(quest.id)).toEqual(['AM-3', 'AM-1', 'AM-2']);

		await rankQuestLabour(db, actor, quest.id, c.id, { after: a.id });
		expect(await keys(quest.id)).toEqual(['AM-1', 'AM-3', 'AM-2']);

		await rankQuestLabour(db, actor, quest.id, a.id, 'bottom');
		expect(await keys(quest.id)).toEqual(['AM-3', 'AM-2', 'AM-1']);

		await rankQuestLabour(db, actor, quest.id, a.id, { before: c.id });
		expect(await keys(quest.id)).toEqual(['AM-1', 'AM-3', 'AM-2']);
	});

	it('keeps its own order, independent of the board', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, b.id);
		await addQuestLabour(db, actor, quest.id, a.id);

		await updateLabour(db, actor, b.id, { placement: 'bottom' });

		expect((await readQuest(db, quest.id)).labours.map((t) => t.id)).toEqual([b.id, a.id]);
	});

	it('refuses to rank against a Labour outside the Quest, or a Labour not in it', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const outside = await seedLabour(db, { realmId: realm.id });
		const quest = await seedQuest();
		await addQuestLabour(db, actor, quest.id, a.id);

		await expectDomainError(
			() => addQuestLabour(db, actor, quest.id, outside.id, { before: 999 }),
			'invalid'
		);
		await expectDomainError(
			() => rankQuestLabour(db, actor, quest.id, a.id, { after: outside.id }),
			'invalid'
		);
		await expectDomainError(
			() => rankQuestLabour(db, actor, quest.id, outside.id, 'top'),
			'not_found'
		);
	});
});

describe('progress', () => {
	it('is the Closed Labours over all Labours, across Realms', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const a = await seedLabour(db, { realmId: am.id });
		const b = await seedLabour(db, { realmId: bl.id });
		const c = await seedLabour(db, { realmId: bl.id });
		const quest = await seedQuest();
		for (const labour of [a, b, c]) await addQuestLabour(db, actor, quest.id, labour.id);

		expect(await questProgress(db, quest.id)).toEqual({ closed: 0, total: 3 });

		await updateLabour(db, actor, a.id, { stateId: (await closedOf(am.id)).id });
		await updateLabour(db, actor, b.id, { stateId: (await closedOf(bl.id)).id });
		expect(await questProgress(db, quest.id)).toEqual({ closed: 2, total: 3 });

		await moveLabour(db, actor, a.id, { realmId: bl.id });
		expect((await readQuest(db, quest.id)).progress).toEqual({ closed: 2, total: 3 });

		await deleteLabour(db, actor, c.id);
		expect((await readQuest(db, quest.id)).progress).toEqual({ closed: 2, total: 2 });
	});

	it('is zero over zero for an empty Quest', async () => {
		expect(await questProgress(db, (await seedQuest()).id)).toEqual({ closed: 0, total: 0 });
	});
});
