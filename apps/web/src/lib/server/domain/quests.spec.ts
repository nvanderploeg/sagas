import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	ownerId = seedUser(db, 'ada');
});

afterEach(() => {
	db.$client.close();
});

function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

const seedQuest = (name = 'Launch') =>
	createQuest(db, actor, { realmId: anyRealmId(db), name, ownerId });
const keys = (questId: number) => listQuestLabours(db, questId).map((t) => t.key);
const closedOf = (realmId: number) => listStates(db, realmId).find((s) => s.isClosed)!;

describe('Quest CRUD', () => {
	it('creates a Quest with a name, description and Owner, and no Labours', () => {
		const quest = createQuest(db, actor, {
			realmId: anyRealmId(db),
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
		expect(listQuests(db).map((q) => q.id)).toEqual([quest.id]);
	});

	it('rejects a blank name and an Owner that does not exist', () => {
		expectDomainError(
			() => createQuest(db, actor, { realmId: anyRealmId(db), name: '  ', ownerId }),
			'invalid'
		);
		expectDomainError(
			() => createQuest(db, actor, { realmId: anyRealmId(db), name: 'x', ownerId: 999 }),
			'invalid'
		);
		expect(listQuests(db)).toEqual([]);
	});

	it('updates the name, description and Owner', () => {
		const quest = seedQuest();
		const grace = seedUser(db, 'grace');

		const updated = updateQuest(db, actor, quest.id, {
			name: 'Relaunch',
			description: 'Again',
			ownerId: grace
		});

		expect(updated).toMatchObject({ name: 'Relaunch', description: 'Again', ownerId: grace });
	});

	it('deletes a Quest and leaves its Labours in place', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, labour.id);

		deleteQuest(db, actor, quest.id);

		expectDomainError(() => readQuest(db, quest.id), 'not_found');
		expect(db.select().from(questLabours).all()).toEqual([]);
		expect(db.select().from(labours).all()).toHaveLength(1);
	});
});

describe('membership', () => {
	it('holds Labours from any Realm, in the order they were added', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		const quest = seedQuest();

		addQuestLabour(db, actor, quest.id, b.id);
		addQuestLabour(db, actor, quest.id, a.id);

		expect(keys(quest.id)).toEqual(['BL-1', 'AM-1']);
		expect(readQuest(db, quest.id).labours.map((t) => t.id)).toEqual([b.id, a.id]);
	});

	it('lets one Labour sit in any number of Quests', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const first = seedQuest('First');
		const second = seedQuest('Second');

		addQuestLabour(db, actor, first.id, labour.id);
		addQuestLabour(db, actor, second.id, labour.id);

		expect(listLabourQuests(db, labour.id).map((q) => q.name)).toEqual(['First', 'Second']);
	});

	it('never adds a Labour Children with it', () => {
		const realm = seedRealm(db, 'AM');
		const parent = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const quest = seedQuest();

		addQuestLabour(db, actor, quest.id, parent.id);

		expect(readQuest(db, quest.id).labours.map((t) => t.id)).toEqual([parent.id]);
	});

	it('adds the direct Children only through the explicit helper, right after the Labour', () => {
		const realm = seedRealm(db, 'AM');
		const first = seedLabour(db, { realmId: realm.id });
		const parent = seedLabour(db, { realmId: realm.id });
		const child = seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const other = seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const grandchild = seedLabour(db, { realmId: realm.id, parentId: child.id });
		const last = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, first.id);
		addQuestLabour(db, actor, quest.id, last.id);
		addQuestLabour(db, actor, quest.id, other.id);

		const view = addQuestLabourWithChildren(db, actor, quest.id, parent.id, {
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
		expectDomainError(() => addQuestLabourWithChildren(db, actor, quest.id, parent.id), 'conflict');
	});

	it('refuses a Labour already in the Quest, and removing one that is not', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, labour.id);

		expectDomainError(() => addQuestLabour(db, actor, quest.id, labour.id), 'conflict');
		removeQuestLabour(db, actor, quest.id, labour.id);
		expectDomainError(() => removeQuestLabour(db, actor, quest.id, labour.id), 'not_found');
		expect(readQuest(db, quest.id).labours.map((t) => t.id)).toEqual([]);
	});

	it('refuses an unknown Labour or Quest', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();

		expectDomainError(() => addQuestLabour(db, actor, quest.id, 999), 'not_found');
		expectDomainError(() => addQuestLabour(db, actor, 999, labour.id), 'not_found');
	});

	it('drops a deleted Labour from every Quest it was in', () => {
		const realm = seedRealm(db, 'AM');
		const gone = seedLabour(db, { realmId: realm.id });
		const kept = seedLabour(db, { realmId: realm.id });
		const first = seedQuest('First');
		const second = seedQuest('Second');
		for (const quest of [first, second]) {
			addQuestLabour(db, actor, quest.id, gone.id);
			addQuestLabour(db, actor, quest.id, kept.id);
		}

		deleteLabour(db, actor, gone.id);

		expect(readQuest(db, first.id).labours.map((t) => t.id)).toEqual([kept.id]);
		expect(readQuest(db, second.id).labours.map((t) => t.id)).toEqual([kept.id]);
	});
});

describe('bulk membership', () => {
	const ids = (questId: number) => readQuest(db, questId).labours.map((t) => t.id);

	it('adds Labours in the order given, at the placement, skipping and reporting members', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b, c, d] = [1, 2, 3, 4].map(() => seedLabour(db, { realmId: realm.id }));
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, a.id);
		addQuestLabour(db, actor, quest.id, b.id);

		const result = addQuestLabours(db, actor, quest.id, [d.id, b.id, c.id, d.id], {
			after: a.id
		});

		expect(result.labourIds).toEqual([d.id, c.id]);
		expect(result.skipped).toEqual([b.id]);
		expect(result.quest.labours.map((t) => t.id)).toEqual([a.id, d.id, c.id, b.id]);
		expect(ids(quest.id)).toEqual([a.id, d.id, c.id, b.id]);
	});

	it('is idempotent: adding members again changes nothing and reports them all', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b] = [1, 2].map(() => seedLabour(db, { realmId: realm.id }));
		const quest = seedQuest();
		addQuestLabours(db, actor, quest.id, [a.id, b.id]);

		const again = addQuestLabours(db, actor, quest.id, [b.id, a.id], 'top');

		expect(again).toMatchObject({ labourIds: [], skipped: [b.id, a.id] });
		expect(ids(quest.id)).toEqual([a.id, b.id]);
	});

	it('never adds Children', () => {
		const realm = seedRealm(db, 'AM');
		const parent = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id, parentId: parent.id });
		const quest = seedQuest();

		addQuestLabours(db, actor, quest.id, [parent.id]);

		expect(ids(quest.id)).toEqual([parent.id]);
	});

	it('adds none when any Labour is unknown or the anchor is not a member', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b] = [1, 2].map(() => seedLabour(db, { realmId: realm.id }));
		const quest = seedQuest();

		expectDomainError(() => addQuestLabours(db, actor, quest.id, [a.id, 999]), 'not_found');
		expectDomainError(
			() => addQuestLabours(db, actor, quest.id, [a.id], { before: b.id }),
			'invalid'
		);
		expectDomainError(() => addQuestLabours(db, actor, 999, [a.id]), 'not_found');
		expect(ids(quest.id)).toEqual([]);
	});

	it('names an anchor outside the Quest by its key', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b] = [1, 2].map(() => seedLabour(db, { realmId: realm.id }));
		const quest = seedQuest();

		expect(() => addQuestLabours(db, actor, quest.id, [a.id], { after: b.id })).toThrow(
			'AM-2 is not in the same Quest'
		);
	});

	it('removes Labours, skipping and reporting the ones not in the Quest', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b, c] = [1, 2, 3].map(() => seedLabour(db, { realmId: realm.id }));
		const quest = seedQuest();
		addQuestLabours(db, actor, quest.id, [a.id, b.id]);

		const result = removeQuestLabours(db, actor, quest.id, [c.id, b.id, a.id, b.id]);

		expect(result).toMatchObject({ labourIds: [b.id, a.id], skipped: [c.id] });
		expect(ids(quest.id)).toEqual([]);
		expect(removeQuestLabours(db, actor, quest.id, [a.id])).toMatchObject({
			labourIds: [],
			skipped: [a.id]
		});
	});

	it('removes none when any Labour is unknown', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, a.id);

		expectDomainError(() => removeQuestLabours(db, actor, quest.id, [a.id, 999]), 'not_found');
		expect(ids(quest.id)).toEqual([a.id]);
	});
});

describe('Quest order', () => {
	it('places a Labour at a position when added, and reorders within the Quest', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b, c] = [1, 2, 3].map(() => seedLabour(db, { realmId: realm.id }));
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, a.id);
		addQuestLabour(db, actor, quest.id, b.id);
		addQuestLabour(db, actor, quest.id, c.id, 'top');
		expect(keys(quest.id)).toEqual(['AM-3', 'AM-1', 'AM-2']);

		rankQuestLabour(db, actor, quest.id, c.id, { after: a.id });
		expect(keys(quest.id)).toEqual(['AM-1', 'AM-3', 'AM-2']);

		rankQuestLabour(db, actor, quest.id, a.id, 'bottom');
		expect(keys(quest.id)).toEqual(['AM-3', 'AM-2', 'AM-1']);

		rankQuestLabour(db, actor, quest.id, a.id, { before: c.id });
		expect(keys(quest.id)).toEqual(['AM-1', 'AM-3', 'AM-2']);
	});

	it('keeps its own order, independent of the board', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, b.id);
		addQuestLabour(db, actor, quest.id, a.id);

		updateLabour(db, actor, b.id, { placement: 'bottom' });

		expect(readQuest(db, quest.id).labours.map((t) => t.id)).toEqual([b.id, a.id]);
	});

	it('refuses to rank against a Labour outside the Quest, or a Labour not in it', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const outside = seedLabour(db, { realmId: realm.id });
		const quest = seedQuest();
		addQuestLabour(db, actor, quest.id, a.id);

		expectDomainError(
			() => addQuestLabour(db, actor, quest.id, outside.id, { before: 999 }),
			'invalid'
		);
		expectDomainError(
			() => rankQuestLabour(db, actor, quest.id, a.id, { after: outside.id }),
			'invalid'
		);
		expectDomainError(() => rankQuestLabour(db, actor, quest.id, outside.id, 'top'), 'not_found');
	});
});

describe('progress', () => {
	it('is the Closed Labours over all Labours, across Realms', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		const c = seedLabour(db, { realmId: bl.id });
		const quest = seedQuest();
		for (const labour of [a, b, c]) addQuestLabour(db, actor, quest.id, labour.id);

		expect(questProgress(db, quest.id)).toEqual({ closed: 0, total: 3 });

		updateLabour(db, actor, a.id, { stateId: closedOf(am.id).id });
		updateLabour(db, actor, b.id, { stateId: closedOf(bl.id).id });
		expect(questProgress(db, quest.id)).toEqual({ closed: 2, total: 3 });

		moveLabour(db, actor, a.id, { realmId: bl.id });
		expect(readQuest(db, quest.id).progress).toEqual({ closed: 2, total: 3 });

		deleteLabour(db, actor, c.id);
		expect(readQuest(db, quest.id).progress).toEqual({ closed: 2, total: 2 });
	});

	it('is zero over zero for an empty Quest', () => {
		expect(questProgress(db, seedQuest().id)).toEqual({ closed: 0, total: 0 });
	});
});
