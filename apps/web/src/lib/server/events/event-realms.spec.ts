import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { eventRealms } from '#lib/server/db/schema.ts';
import { addQuestLabour, createQuest } from '#lib/server/domain/quests.ts';
import { deleteLabour, moveLabour } from '#lib/server/domain/labours.ts';
import { write } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { EVENT_TYPES, type EventData, type EventSpec, type EventType } from './types.ts';
import { eventRealmIds, eventsSince, pruneEvents } from './log.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

async function record(spec: EventSpec): Promise<number[]> {
	await write(db, await seedActor(db), () => ({ value: null, events: [spec] }));
	return eventRealmIds(db, (await eventsSince(db, 0)).at(-1)!.seq);
}

// Only the fields the rules read are filled in.
function spec<K extends EventType>(type: K, data: unknown, realms?: number[]): EventSpec {
	return { type, data: data as EventData[K], realms } as EventSpec;
}

describe('Realms an Event touches', () => {
	it('covers every Event type', async () => {
		const a = (await seedRealm(db, 'AM')).id;
		const b = (await seedRealm(db, 'BM')).id;
		const labour = await seedLabour(db, { realmId: a });
		const scrollView = { realmId: b };
		const cases: Record<EventType, [EventSpec, number[]]> = {
			'realm.created': [spec('realm.created', { realm: { id: a } }), [a]],
			'realm.updated': [spec('realm.updated', { realm: { id: a } }), [a]],
			'realm.deleted': [spec('realm.deleted', { realmId: 99, labourIds: [] }), [99]],
			'state.created': [spec('state.created', { realm: { id: a }, stateId: 1 }), [a]],
			'state.updated': [spec('state.updated', { realm: { id: a }, stateId: 1 }), [a]],
			'state.deleted': [spec('state.deleted', { realm: { id: a }, stateId: 1 }), [a]],
			'substate.created': [spec('substate.created', { realm: { id: b } }), [b]],
			'substate.updated': [spec('substate.updated', { realm: { id: b } }), [b]],
			'substate.deleted': [spec('substate.deleted', { realm: { id: b } }), [b]],
			'labour.created': [spec('labour.created', { labour: { realmId: a } }), [a]],
			'labour.updated': [spec('labour.updated', { labour: { realmId: a } }), [a]],
			'labour.moved': [spec('labour.moved', { labour: { realmId: b }, fromRealmId: a }), [a, b]],
			'labour.reparented': [spec('labour.reparented', { labour: { realmId: a } }), [a]],
			'labour.ranked': [spec('labour.ranked', { id: labour.id }), [a]],
			'labour.rekeyed': [spec('labour.rekeyed', { realmId: b, labours: [] }), [b]],
			'labour.deleted': [spec('labour.deleted', { id: 999, realmId: b }), [b]],
			'labour.commented': [spec('labour.commented', { comment: { labourId: labour.id } }), [a]],
			'labour.comment_edited': [
				spec('labour.comment_edited', { comment: { labourId: labour.id } }),
				[a]
			],
			'labour.comment_deleted': [
				spec('labour.comment_deleted', { id: 1, labourId: labour.id }),
				[a]
			],
			'quest.created': [spec('quest.created', { quest: { realmId: a } }), []],
			'quest.updated': [spec('quest.updated', { quest: { realmId: a } }), []],
			'quest.deleted': [spec('quest.deleted', { id: 1, realmId: a }), []],
			'quest.labours_added': [
				spec('quest.labours_added', { quest: {}, labourIds: [labour.id] }),
				[a]
			],
			'quest.labours_removed': [
				spec('quest.labours_removed', { quest: {}, labourIds: [labour.id] }),
				[a]
			],
			'quest.labour_ranked': [spec('quest.labour_ranked', { quest: {}, labourId: labour.id }), []],
			'scroll.created': [spec('scroll.created', { scroll: scrollView }), [b]],
			'scroll.updated': [spec('scroll.updated', { scroll: scrollView }), [b]],
			'scroll.moved': [spec('scroll.moved', { scroll: scrollView, paths: [] }), [b]],
			'scroll.deleted': [spec('scroll.deleted', { realmId: b, ids: [], moved: [] }), [b]]
		};

		expect(Object.keys(cases).sort()).toEqual([...EVENT_TYPES].sort());
		for (const [type, [event, realms]] of Object.entries(cases)) {
			expect([type, await record(event)]).toEqual([type, realms]);
		}
	});

	it('uses an explicit realms list in place of the derived one', async () => {
		const a = (await seedRealm(db, 'AM')).id;
		const b = (await seedRealm(db, 'BM')).id;

		expect(
			await record(spec('quest.labours_removed', { quest: {}, labourIds: [999] }, [b, a]))
		).toEqual([a, b]);
	});

	it('records a moved Labour in both Realms', async () => {
		const a = (await seedRealm(db, 'AM')).id;
		const b = (await seedRealm(db, 'BM')).id;
		const labour = await seedLabour(db, { realmId: a });

		await moveLabour(db, await seedActor(db), labour.id, { realmId: b });

		const moved = (await eventsSince(db, 0)).find((e) => e.type === 'labour.moved')!;
		expect(await eventRealmIds(db, moved.seq)).toEqual([a, b]);
	});

	it('records the Realm of a Labour deleted in the same write', async () => {
		const a = (await seedRealm(db, 'AM')).id;
		const b = (await seedRealm(db, 'BM')).id;
		const actor = await seedActor(db);
		const quest = await createQuest(db, actor, { realmId: a, name: 'Q', ownerId: actor.id });
		const labour = await seedLabour(db, { realmId: b });
		await addQuestLabour(db, actor, quest.id, labour.id);

		await deleteLabour(db, actor, labour.id);

		const removed = (await eventsSince(db, 0)).find((e) => e.type === 'quest.labours_removed')!;
		expect(await eventRealmIds(db, removed.seq)).toEqual([b]);
		const deleted = (await eventsSince(db, 0)).find((e) => e.type === 'labour.deleted')!;
		expect(await eventRealmIds(db, deleted.seq)).toEqual([b]);
	});

	it('keeps a deleted Realm id after its Events are recorded', async () => {
		const a = (await seedRealm(db, 'AM')).id;
		const realmCreated = (await eventsSince(db, 0))[0];
		await db.$client.query('DELETE FROM sagas_realms WHERE id = $1', [a]);

		expect(await eventRealmIds(db, realmCreated.seq)).toEqual([a]);
	});

	it('removes rows with their pruned Events', async () => {
		await seedUser(db);
		const a = (await seedRealm(db, 'AM')).id;
		await seedLabour(db, { realmId: a });
		expect((await db.select().from(eventRealms)).length).toBeGreaterThan(0);

		await pruneEvents(db, 1, Date.now() + 24 * 60 * 60 * 1000);

		expect(await db.select().from(eventRealms)).toEqual([]);
	});
});
