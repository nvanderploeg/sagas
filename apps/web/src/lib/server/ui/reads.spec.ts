import { anyRealmId } from '#lib/server/test/fixtures.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client.ts';
import { updateLabour } from '../domain/labours.ts';
import { addQuestLabour, createQuest } from '../domain/quests.ts';
import { createState } from '../domain/states.ts';
import type { Actor } from '../domain/write.ts';
import { testDb } from '../test/db.ts';
import { seedActor, seedRealm, seedLabour, seedUser } from '../test/fixtures.ts';
import { readHome, readLabourPage } from './reads.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

function statements(read: () => unknown): number {
	const prepare = vi.spyOn(db.$client, 'prepare');
	read();
	const count = prepare.mock.calls.length;
	prepare.mockRestore();
	return count;
}

function questsWithMembers(ownerId: number, count: number, realmId: number) {
	for (let i = 0; i < count; i++) {
		const quest = createQuest(db, actor, { realmId: anyRealmId(db), name: `Quest ${i}`, ownerId });
		for (let j = 0; j < 3; j++) {
			addQuestLabour(db, actor, quest.id, seedLabour(db, { realmId, ownerId }).id);
		}
	}
}

describe('page reads', () => {
	it('read a Labour page in as many statements however many Quests exist', () => {
		const realm = seedRealm(db);
		const labour = seedLabour(db, { realmId: realm.id, ownerId: actor.id });
		questsWithMembers(actor.id, 1, realm.id);
		const few = statements(() => readLabourPage(db, actor, labour.id));

		questsWithMembers(actor.id, 12, realm.id);
		expect(statements(() => readLabourPage(db, actor, labour.id))).toBe(few);
		expect(readLabourPage(db, actor, labour.id).quests).toHaveLength(13);
		expect(Object.keys(readLabourPage(db, actor, labour.id).quests[0]).sort()).toEqual([
			'id',
			'name'
		]);
	});

	it('read Home without touching the Quests other Users own', () => {
		const realm = seedRealm(db);
		const other = seedUser(db, 'other');
		questsWithMembers(actor.id, 2, realm.id);
		const few = statements(() => readHome(db, actor));

		questsWithMembers(other, 12, realm.id);
		expect(statements(() => readHome(db, actor))).toBe(few);
		expect(readHome(db, actor).quests.map((q) => q.ownerId)).toEqual([actor.id, actor.id]);
	});

	it("lists only the User's Labours in open States", () => {
		const realm = seedRealm(db);
		const backlog = createState(
			db,
			actor,
			realm.id,
			{ key: 'backlog', label: 'Backlog', color: '#000000', icon: 'dot' },
			undefined,
			false
		);
		const ready = seedLabour(db, { realmId: realm.id, ownerId: actor.id });
		const groom = seedLabour(db, { realmId: realm.id, ownerId: actor.id });
		updateLabour(db, actor, groom.id, { stateId: backlog.id });

		expect(readHome(db, actor).mine.map((t) => t.id)).toEqual([ready.id]);
	});
});
