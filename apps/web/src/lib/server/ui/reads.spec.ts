import { anyRealmId } from '#lib/server/test/fixtures.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { updateLabour } from '../domain/labours.ts';
import { addQuestLabour, createQuest } from '../domain/quests.ts';
import { createState } from '../domain/states.ts';
import type { Actor } from '../domain/write.ts';
import { testDb } from '../test/db.ts';
import { seedActor, seedRealm, seedLabour, seedUser } from '../test/fixtures.ts';
import { readHome, readLabourPage } from './reads.ts';
import { countStatements } from '#lib/server/test/db.ts';

let db: Db;
let actor: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

function statements(run: () => unknown): Promise<number> {
	return countStatements(run);
}

async function questsWithMembers(ownerId: number, count: number, realmId: number) {
	for (let i = 0; i < count; i++) {
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: `Quest ${i}`,
			ownerId
		});
		for (let j = 0; j < 3; j++) {
			await addQuestLabour(db, actor, quest.id, (await seedLabour(db, { realmId, ownerId })).id);
		}
	}
}

describe('page reads', () => {
	it('read a Labour page in as many statements however many Quests exist', async () => {
		const realm = await seedRealm(db);
		const labour = await seedLabour(db, { realmId: realm.id, ownerId: actor.id });
		await questsWithMembers(actor.id, 1, realm.id);
		const few = await statements(() => readLabourPage(db, actor, labour.id));

		await questsWithMembers(actor.id, 12, realm.id);
		expect(await statements(() => readLabourPage(db, actor, labour.id))).toBe(few);
		expect((await readLabourPage(db, actor, labour.id)).quests).toHaveLength(13);
		expect(Object.keys((await readLabourPage(db, actor, labour.id)).quests[0]).sort()).toEqual([
			'id',
			'name'
		]);
	});

	it('read Home without touching the Quests other Users own', async () => {
		const realm = await seedRealm(db);
		const other = await seedUser(db, 'other');
		await questsWithMembers(actor.id, 2, realm.id);
		const few = await statements(() => readHome(db, actor));

		await questsWithMembers(other, 12, realm.id);
		expect(await statements(() => readHome(db, actor))).toBe(few);
		expect((await readHome(db, actor)).quests.map((q) => q.ownerId)).toEqual([actor.id, actor.id]);
	});

	it("lists only the User's Labours in open States", async () => {
		const realm = await seedRealm(db);
		const backlog = await createState(
			db,
			actor,
			realm.id,
			{ key: 'backlog', label: 'Backlog', color: '#000000', icon: 'dot' },
			undefined,
			false
		);
		const ready = await seedLabour(db, { realmId: realm.id, ownerId: actor.id });
		const groom = await seedLabour(db, { realmId: realm.id, ownerId: actor.id });
		await updateLabour(db, actor, groom.id, { stateId: backlog.id });

		expect((await readHome(db, actor)).mine.map((t) => t.id)).toEqual([ready.id]);
	});
});
