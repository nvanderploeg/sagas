import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, quests, labours, users } from '#lib/server/db/schema.ts';
import { insertApiToken } from '#lib/server/auth/tokens.ts';
import { subscribe } from '#lib/server/events/bus.ts';
import { eventsSince } from '#lib/server/events/log.ts';
import type { SagasEvent } from '#lib/server/events/types.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedRealm, seedLabour, seedUser, TODO, anyRealmId } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	addQuestLabour,
	addQuestLabours,
	addQuestLabourWithChildren,
	createQuest,
	deleteQuest,
	rankQuestLabour,
	readQuest,
	removeQuestLabour,
	removeQuestLabours,
	updateQuest
} from './quests.ts';
import {
	createRealm,
	deleteRealm,
	readRealm,
	renameRealmKey,
	setInitialState,
	updateRealm
} from './realms.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	listStates,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	updateState,
	updateSubstate
} from './states.ts';
import {
	createLabour,
	deleteLabour,
	moveLabour,
	rankLabour,
	readLabour,
	setParent,
	updateLabour
} from './labours.ts';
import type { Actor } from './write.ts';
import { inTransaction } from '#lib/server/db/tx.ts';

let db: Db;
let actor: Actor;
let published: SagasEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
	db = await testDb();
	actor = {
		id: (
			await db
				.insert(users)
				.values({ kind: 'human', username: 'writer', displayName: 'The Writer' })
				.returning()
		)[0].id
	};
	published = [];
	unsubscribe = subscribe((event) => published.push(event));
});

afterEach(() => {
	unsubscribe();
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const lastSeq = async () => (await db.select().from(events)).at(-1)?.seq ?? 0;

// Runs one write and returns the Events it recorded, after checking they were published as stored.
async function recorded(action: () => unknown): Promise<SagasEvent[]> {
	const before = await lastSeq();
	published = [];
	await action();
	const found = await eventsSince(db, before);
	expect(published).toEqual(found);
	return found;
}

async function expectOneEvent(action: () => unknown): Promise<SagasEvent> {
	const found = await recorded(action);
	expect(found).toHaveLength(1);
	return found[0];
}

const shape = (found: SagasEvent[]) => found.map((e) => [e.type, e.data]);

describe('the Event record', () => {
	it("carries the seq, type, time, the actor's display info and the data", async () => {
		const event = await expectOneEvent(() =>
			createRealm(db, actor, { name: 'Amber', key: 'AM', initialState: TODO })
		);

		expect(Object.keys(event).sort()).toEqual(['actor', 'createdAt', 'data', 'seq', 'type']);
		expect(event.actor).toEqual({
			id: actor.id,
			kind: 'human',
			username: 'writer',
			displayName: 'The Writer',
			via: null
		});
		expect(event.createdAt).toBeInstanceOf(Date);
	});

	it('names the API token the write came through, in the live Event and in replay', async () => {
		const via = {
			tokenId: (await insertApiToken(db, actor.id, 'norm-mint-main')).id,
			name: 'norm-mint-main'
		};

		const event = await expectOneEvent(() =>
			createRealm(db, { ...actor, via }, { name: 'Amber', key: 'AM', initialState: TODO })
		);

		expect(event.actor.via).toEqual(via);
		expect((await eventsSince(db, event.seq - 1))[0].actor.via).toEqual(via);
	});
});

describe('Realm config writes', () => {
	it('record one Event each, carrying the Realm config and the State or Substate they touch', async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = realm.initialStateId!;
		let doingId = 0;
		let reviewId = 0;
		let qaId = 0;
		const config = async () => json(await readRealm(db, realm.id));

		const cases: [string, () => unknown, () => Promise<object>][] = [
			[
				'realm.updated',
				() => updateRealm(db, actor, realm.id, { name: 'Amber' }),
				async () => ({ realm: await config() })
			],
			[
				'state.created',
				async () => (doingId = (await createState(db, actor, realm.id, style('doing'))).id),
				async () => ({ realm: await config(), stateId: doingId })
			],
			[
				'state.updated',
				() => updateState(db, actor, doingId, { label: 'Doing' }),
				async () => ({ realm: await config(), stateId: doingId })
			],
			[
				'state.updated',
				() => moveState(db, actor, doingId, 0),
				async () => ({ realm: await config(), stateId: doingId })
			],
			[
				'realm.updated',
				() => setInitialState(db, actor, realm.id, doingId),
				async () => ({ realm: await config() })
			],
			[
				'substate.created',
				async () => (reviewId = (await createSubstate(db, actor, todo, style('review'))).id),
				async () => ({ realm: await config(), stateId: todo, substateId: reviewId })
			],
			[
				'substate.created',
				async () => (qaId = (await createSubstate(db, actor, todo, style('qa'))).id),
				async () => ({ realm: await config(), stateId: todo, substateId: qaId })
			],
			[
				'substate.updated',
				() => updateSubstate(db, actor, qaId, { color: '#ffffff' }),
				async () => ({ realm: await config(), stateId: todo, substateId: qaId })
			],
			[
				'substate.updated',
				() => moveSubstate(db, actor, qaId, 0),
				async () => ({ realm: await config(), stateId: todo, substateId: qaId })
			],
			[
				'state.updated',
				() => setDefaultSubstate(db, actor, todo, qaId),
				async () => ({ realm: await config(), stateId: todo })
			],
			[
				'substate.deleted',
				() => deleteSubstate(db, actor, reviewId),
				async () => ({ realm: await config(), stateId: todo, substateId: reviewId })
			],
			[
				'state.deleted',
				async () => {
					await setInitialState(db, actor, realm.id, todo);
					await deleteState(db, actor, doingId);
				},
				async () => ({ realm: await config(), stateId: doingId })
			]
		];

		for (const [type, action, data] of cases) {
			const found = await recorded(action);
			const event = found.at(-1)!;
			expect(event.type, type).toBe(type);
			expect(event.data, type).toEqual(await data());
		}
	});

	it('records realm.created with the config, and realm.deleted with the Labours it took', async () => {
		let realmId = 0;
		const created = await expectOneEvent(
			async () =>
				(realmId = (await createRealm(db, actor, { name: 'Amber', key: 'AM', initialState: TODO }))
					.id)
		);
		expect(created).toMatchObject({
			type: 'realm.created',
			data: { realm: json(await readRealm(db, realmId)) }
		});
		const a = await seedLabour(db, { realmId });
		const b = await seedLabour(db, { realmId, parentId: a.id });

		const deleted = await expectOneEvent(() => deleteRealm(db, actor, realmId));

		expect(deleted).toMatchObject({
			type: 'realm.deleted',
			data: { realmId, labourIds: [a.id, b.id] }
		});
	});

	it('records the new key of every Labour in a Realm whose key is renamed', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });

		const found = await recorded(() => renameRealmKey(db, actor, realm.id, 'AB'));

		expect(shape(found)).toEqual([
			['realm.updated', { realm: json(await readRealm(db, realm.id)) }],
			[
				'labour.rekeyed',
				{
					realmId: realm.id,
					labours: [
						{ id: a.id, previousKey: 'AM-1', key: 'AB-1' },
						{ id: b.id, previousKey: 'AM-2', key: 'AB-2' }
					]
				}
			]
		]);
	});

	it("records each Labour a State's first Substate takes in, with its updatedAt moved", async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = realm.initialStateId!;
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		await db.update(labours).set({ updatedAt: new Date(0) });
		let substateId = 0;

		const found = await recorded(
			async () => (substateId = (await createSubstate(db, actor, todo, style('rev'))).id)
		);

		expect(shape(found)).toEqual([
			[
				'substate.created',
				{ realm: json(await readRealm(db, realm.id)), stateId: todo, substateId }
			],
			['labour.updated', { labour: json(await readLabour(db, a.id)) }],
			['labour.updated', { labour: json(await readLabour(db, b.id)) }]
		]);
		expect(await readLabour(db, a.id)).toMatchObject({ substateId });
		expect((await readLabour(db, a.id)).updatedAt.getTime()).toBeGreaterThan(0);
	});

	it('deletes the Quests of a deleted Realm, one quest.deleted each, and spares the Labours they listed', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const kept = await seedLabour(db, { realmId: bl.id });
		const quest = await createQuest(db, actor, { realmId: am.id, name: 'Q', ownerId: actor.id });
		await addQuestLabour(db, actor, quest.id, kept.id);

		const found = await recorded(() => deleteRealm(db, actor, am.id));

		expect(shape(found).map(([type]) => type)).toEqual(['realm.deleted', 'quest.deleted']);
		expect(found[1].data).toEqual({ id: quest.id, realmId: am.id });
		expect((await readLabour(db, kept.id)).id).toBe(kept.id);
	});

	it('records the Children it detaches in other Realms and the Quests it shrinks when deleting a Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const parent = await seedLabour(db, { realmId: am.id });
		const child = await seedLabour(db, { realmId: bl.id, parentId: parent.id });
		const quest = await createQuest(db, actor, {
			realmId: bl.id,
			name: 'Launch',
			ownerId: actor.id
		});
		await addQuestLabour(db, actor, quest.id, parent.id);
		await addQuestLabour(db, actor, quest.id, child.id);
		await db.update(labours).set({ updatedAt: new Date(0) });
		await db.update(quests).set({ updatedAt: new Date(0) });

		const found = await recorded(() => deleteRealm(db, actor, am.id));

		const after = await readQuest(db, quest.id);
		expect(shape(found)).toEqual([
			['realm.deleted', { realmId: am.id, labourIds: [parent.id] }],
			['labour.reparented', { labour: json(await readLabour(db, child.id)) }],
			['quest.labours_removed', { quest: json(after), labourIds: [parent.id] }]
		]);
		expect((await readLabour(db, child.id)).parentId).toBeNull();
		expect((await readLabour(db, child.id)).updatedAt.getTime()).toBeGreaterThan(0);
		expect(after.progress).toEqual({ closed: 0, total: 1 });
		expect(after.updatedAt.getTime()).toBeGreaterThan(0);
	});
});

describe('Labour writes', () => {
	it('record one Event each, carrying the Labour with its current key', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const ownerId = await seedUser(db, 'ada');
		const parent = await seedLabour(db, { realmId: bl.id, ownerId });
		let labourId = 0;
		const labour = async () => ({ labour: json(await readLabour(db, labourId)) });

		const created = await expectOneEvent(
			async () =>
				(labourId = (await createLabour(db, actor, { realmId: am.id, title: 'Fix', ownerId })).id)
		);
		expect(created).toMatchObject({ type: 'labour.created', data: await labour() });
		expect((await labour()).labour).toMatchObject({ key: 'AM-1', closed: false });

		const updated = await expectOneEvent(() =>
			updateLabour(db, actor, labourId, { title: 'Fixed' })
		);
		expect(updated).toMatchObject({ type: 'labour.updated', data: await labour() });

		const reparented = await expectOneEvent(() => setParent(db, actor, labourId, parent.id));
		expect(reparented).toMatchObject({ type: 'labour.reparented', data: await labour() });

		const moved = await expectOneEvent(() => moveLabour(db, actor, labourId, { realmId: bl.id }));
		expect(moved).toMatchObject({ type: 'labour.moved', data: await labour() });
		expect((await labour()).labour).toMatchObject({ key: 'BL-2', realmId: bl.id });
	});

	it('records a rank change as just the Labour, its State and its new Rank', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id });

		const ranked = await expectOneEvent(() => rankLabour(db, actor, a.id, 'bottom'));

		expect(ranked).toMatchObject({
			type: 'labour.ranked',
			data: { id: a.id, stateId: a.stateId, rank: (await readLabour(db, a.id)).rank }
		});
		expect(Object.keys(ranked.data).sort()).toEqual(['id', 'rank', 'stateId']);
	});

	it('records an update that changes only the Rank as labour.ranked', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id });

		const ranked = await expectOneEvent(() =>
			updateLabour(db, actor, a.id, { title: a.title, stateId: a.stateId, placement: 'bottom' })
		);

		expect(shape([ranked])).toEqual([
			['labour.ranked', { id: a.id, stateId: a.stateId, rank: (await readLabour(db, a.id)).rank }]
		]);
		expect((await readLabour(db, a.id)).updatedAt).toEqual(a.updatedAt);
	});

	it('records an update that changes the Rank with another field as labour.updated', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id });

		const updated = await expectOneEvent(() =>
			updateLabour(db, actor, a.id, { title: 'Renamed', placement: 'bottom' })
		);

		expect(shape([updated])).toEqual([
			['labour.updated', { labour: json(await readLabour(db, a.id)) }]
		]);
	});

	it('records the Children it detaches and the Quests it shrinks when deleting a Labour', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const parent = await seedLabour(db, { realmId: am.id });
		const near = await seedLabour(db, { realmId: am.id, parentId: parent.id });
		const far = await seedLabour(db, { realmId: bl.id, parentId: parent.id });
		const first = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'One',
			ownerId: actor.id
		});
		const second = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Two',
			ownerId: actor.id
		});
		await addQuestLabour(db, actor, first.id, parent.id);
		await addQuestLabour(db, actor, second.id, far.id);
		await addQuestLabour(db, actor, second.id, parent.id);
		await db.update(quests).set({ updatedAt: new Date(0) });

		const found = await recorded(() => deleteLabour(db, actor, parent.id));

		expect(shape(found)).toEqual([
			['labour.deleted', { id: parent.id, realmId: am.id }],
			['labour.reparented', { labour: json(await readLabour(db, near.id)) }],
			['labour.reparented', { labour: json(await readLabour(db, far.id)) }],
			[
				'quest.labours_removed',
				{ quest: json(await readQuest(db, first.id)), labourIds: [parent.id] }
			],
			[
				'quest.labours_removed',
				{ quest: json(await readQuest(db, second.id)), labourIds: [parent.id] }
			]
		]);
		expect((await readLabour(db, far.id)).parentId).toBeNull();
		expect((await readQuest(db, first.id)).updatedAt.getTime()).toBeGreaterThan(0);
	});
});

describe('Quest writes', () => {
	it('record one Event each, carrying the Quest with its member Labours in order', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const a = await seedLabour(db, { realmId: am.id });
		const b = await seedLabour(db, { realmId: bl.id });
		const c = await seedLabour(db, { realmId: bl.id, parentId: b.id });
		let questId = 0;
		const quest = async () => json(await readQuest(db, questId));

		const cases: [string, () => unknown, () => object][] = [
			[
				'quest.created',
				async () =>
					(questId = (
						await createQuest(db, actor, {
							realmId: await anyRealmId(db),
							name: 'Launch',
							ownerId: actor.id
						})
					).id),
				async () => ({ quest: await quest() })
			],
			[
				'quest.updated',
				() => updateQuest(db, actor, questId, { name: 'Ship' }),
				async () => ({ quest: await quest() })
			],
			[
				'quest.labours_added',
				() => addQuestLabour(db, actor, questId, a.id),
				async () => ({ quest: await quest(), labourIds: [a.id] })
			],
			[
				'quest.labours_added',
				() => addQuestLabourWithChildren(db, actor, questId, b.id),
				async () => ({ quest: await quest(), labourIds: [b.id, c.id] })
			],
			[
				'quest.labour_ranked',
				() => rankQuestLabour(db, actor, questId, a.id, 'bottom'),
				async () => ({ quest: await quest(), labourId: a.id })
			],
			[
				'quest.labours_removed',
				() => removeQuestLabour(db, actor, questId, a.id),
				async () => ({ quest: await quest(), labourIds: [a.id] })
			]
		];
		for (const [type, action, data] of cases) {
			const event = await expectOneEvent(action);
			expect(event.type, type).toBe(type);
			expect(event.data, type).toEqual(await data());
		}
		expect((await quest()).labours.map((t: { id: number }) => t.id)).toEqual([b.id, c.id]);

		const deleted = await expectOneEvent(() => deleteQuest(db, actor, questId));
		expect(deleted).toMatchObject({ type: 'quest.deleted', data: { id: questId } });
	});
});

describe('bulk Quest membership', () => {
	it('records one Event per call, naming only the Labours that changed', async () => {
		const realm = await seedRealm(db, 'AM');
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => seedLabour(db, { realmId: realm.id })));
		const questId = (
			await createQuest(db, actor, {
				realmId: await anyRealmId(db),
				name: 'Launch',
				ownerId: actor.id
			})
		).id;
		await addQuestLabour(db, actor, questId, b.id);
		const quest = async () => json(await readQuest(db, questId));

		const added = await recorded(() => addQuestLabours(db, actor, questId, [a.id, b.id, c.id]));
		expect(shape(added)).toEqual([
			['quest.labours_added', { quest: await quest(), labourIds: [a.id, c.id] }]
		]);

		const removed = await recorded(() => removeQuestLabours(db, actor, questId, [c.id, a.id]));
		expect(shape(removed)).toEqual([
			['quest.labours_removed', { quest: await quest(), labourIds: [c.id, a.id] }]
		]);
	});

	it('records no Event when every Labour is skipped', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const questId = (
			await createQuest(db, actor, {
				realmId: await anyRealmId(db),
				name: 'Launch',
				ownerId: actor.id
			})
		).id;
		await addQuestLabour(db, actor, questId, a.id);

		const found = await recorded(async () => {
			await addQuestLabours(db, actor, questId, [a.id]);
			await removeQuestLabours(db, actor, questId, [
				(await seedLabour(db, { realmId: realm.id })).id
			]);
		});

		expect(found.filter((e) => e.type.startsWith('quest.'))).toEqual([]);
	});

	it('records nothing when a Labour is unknown', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const questId = (
			await createQuest(db, actor, {
				realmId: await anyRealmId(db),
				name: 'Launch',
				ownerId: actor.id
			})
		).id;

		const found = await recorded(
			async () =>
				await expect(addQuestLabours(db, actor, questId, [a.id, 999])).rejects.toThrow(DomainError)
		);

		expect(found).toEqual([]);
	});
});

describe('no-op writes', () => {
	it('records no Event for a write that changes nothing', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, title: 'Same' });

		const found = await recorded(async () => {
			await updateRealm(db, actor, realm.id, { name: realm.name });
			await renameRealmKey(db, actor, realm.id, 'am');
			await setInitialState(db, actor, realm.id, realm.initialStateId!);
			await updateState(db, actor, realm.initialStateId!, { label: TODO.label });
			await moveState(db, actor, realm.initialStateId!, 0);
			await updateLabour(db, actor, labour.id, { title: 'Same', stateId: labour.stateId });
			await setParent(db, actor, labour.id, null);
		});

		expect(found).toEqual([]);
	});
});

describe('failed writes', () => {
	it('leaves no Event and publishes nothing when a write is refused', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		const found = await recorded(async () => {
			for (const action of [
				() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId: 999 }),
				() => setParent(db, actor, labour.id, labour.id),
				async () => deleteState(db, actor, (await listStates(db, realm.id)).at(-1)!.id),
				() => renameRealmKey(db, actor, realm.id, '1')
			]) {
				await expect(action()).rejects.toThrow(DomainError);
			}
		});

		expect(found).toEqual([]);
	});

	it('rolls back the write with its Events when recording them fails', async () => {
		const realm = await seedRealm(db, 'AM');
		const ghost = { id: 999 };
		const before = await db.select().from(labours);

		const found = await recorded(
			async () =>
				await expect(
					createLabour(db, ghost, { realmId: realm.id, title: 'x', ownerId: actor.id })
				).rejects.toThrow()
		);

		expect(found).toEqual([]);
		expect(await db.select().from(labours)).toEqual(before);
	});
});

describe('Event seqs', () => {
	it('start at 1 with no gaps, and the counter ends on the last one', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		await deleteRealm(db, actor, realm.id);

		const seqs = (await db.select().from(events)).map((e) => e.seq).sort((a, b) => a - b);
		const counter = await db.$client.query<{ last: number }>(
			'SELECT last FROM sagas_event_counter'
		);

		expect(seqs.length).toBeGreaterThan(2);
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));
		expect(counter.rows[0].last).toBe(seqs.length);
	});
});

describe('publishing', () => {
	it("publishes a write's Events after its commit, with consecutive seqs, as stored", async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const parent = await seedLabour(db, { realmId: am.id });
		await seedLabour(db, { realmId: bl.id, parentId: parent.id });
		const inside: boolean[] = [];
		const stop = subscribe(() => inside.push(inTransaction()));
		const before = await lastSeq();

		const found = await recorded(() => deleteRealm(db, actor, am.id));
		stop();

		expect(found.length).toBeGreaterThan(1);
		expect(inside).toEqual(found.map(() => false));
		expect(found.map((e) => e.seq)).toEqual(found.map((_, i) => before + 1 + i));
		expect((await db.select().from(events)).map((e) => e.seq).slice(-found.length)).toEqual(
			found.map((e) => e.seq)
		);
	});
});
