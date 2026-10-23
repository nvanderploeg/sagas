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

let db: Db;
let actor: Actor;
let published: SagasEvent[];
let unsubscribe: () => void;

beforeEach(() => {
	db = testDb();
	actor = {
		id: db
			.insert(users)
			.values({ kind: 'agent', username: 'writer', displayName: 'The Writer' })
			.returning()
			.get().id
	};
	published = [];
	unsubscribe = subscribe((event) => published.push(event));
});

afterEach(() => {
	unsubscribe();
	db.$client.close();
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const lastSeq = () => db.select().from(events).all().at(-1)?.seq ?? 0;

// Runs one write and returns the Events it recorded, after checking they were published as stored.
function recorded(action: () => unknown): SagasEvent[] {
	const before = lastSeq();
	published = [];
	action();
	const found = eventsSince(db, before);
	expect(published).toEqual(found);
	return found;
}

function expectOneEvent(action: () => unknown): SagasEvent {
	const found = recorded(action);
	expect(found).toHaveLength(1);
	return found[0];
}

const shape = (found: SagasEvent[]) => found.map((e) => [e.type, e.data]);

describe('the Event record', () => {
	it("carries the seq, type, time, the actor's display info and the data", () => {
		const event = expectOneEvent(() =>
			createRealm(db, actor, { name: 'Amber', key: 'AM', initialState: TODO })
		);

		expect(Object.keys(event).sort()).toEqual(['actor', 'createdAt', 'data', 'seq', 'type']);
		expect(event.actor).toEqual({
			id: actor.id,
			kind: 'agent',
			username: 'writer',
			displayName: 'The Writer',
			via: null
		});
		expect(event.createdAt).toBeInstanceOf(Date);
	});

	it('names the API token the write came through, in the live Event and in replay', () => {
		const via = {
			tokenId: insertApiToken(db, actor.id, 'norm-mint-main').id,
			name: 'norm-mint-main'
		};

		const event = expectOneEvent(() =>
			createRealm(db, { ...actor, via }, { name: 'Amber', key: 'AM', initialState: TODO })
		);

		expect(event.actor.via).toEqual(via);
		expect(eventsSince(db, event.seq - 1)[0].actor.via).toEqual(via);
	});
});

describe('Realm config writes', () => {
	it('record one Event each, carrying the Realm config and the State or Substate they touch', () => {
		const realm = seedRealm(db, 'AM');
		const todo = realm.initialStateId!;
		let doingId = 0;
		let reviewId = 0;
		let qaId = 0;
		const config = () => json(readRealm(db, realm.id));

		const cases: [string, () => void, () => object][] = [
			[
				'realm.updated',
				() => updateRealm(db, actor, realm.id, { name: 'Amber' }),
				() => ({ realm: config() })
			],
			[
				'state.created',
				() => (doingId = createState(db, actor, realm.id, style('doing')).id),
				() => ({ realm: config(), stateId: doingId })
			],
			[
				'state.updated',
				() => updateState(db, actor, doingId, { label: 'Doing' }),
				() => ({ realm: config(), stateId: doingId })
			],
			[
				'state.updated',
				() => moveState(db, actor, doingId, 0),
				() => ({ realm: config(), stateId: doingId })
			],
			[
				'realm.updated',
				() => setInitialState(db, actor, realm.id, doingId),
				() => ({ realm: config() })
			],
			[
				'substate.created',
				() => (reviewId = createSubstate(db, actor, todo, style('review')).id),
				() => ({ realm: config(), stateId: todo, substateId: reviewId })
			],
			[
				'substate.created',
				() => (qaId = createSubstate(db, actor, todo, style('qa')).id),
				() => ({ realm: config(), stateId: todo, substateId: qaId })
			],
			[
				'substate.updated',
				() => updateSubstate(db, actor, qaId, { color: '#ffffff' }),
				() => ({ realm: config(), stateId: todo, substateId: qaId })
			],
			[
				'substate.updated',
				() => moveSubstate(db, actor, qaId, 0),
				() => ({ realm: config(), stateId: todo, substateId: qaId })
			],
			[
				'state.updated',
				() => setDefaultSubstate(db, actor, todo, qaId),
				() => ({ realm: config(), stateId: todo })
			],
			[
				'substate.deleted',
				() => deleteSubstate(db, actor, reviewId),
				() => ({ realm: config(), stateId: todo, substateId: reviewId })
			],
			[
				'state.deleted',
				() => {
					setInitialState(db, actor, realm.id, todo);
					deleteState(db, actor, doingId);
				},
				() => ({ realm: config(), stateId: doingId })
			]
		];

		for (const [type, action, data] of cases) {
			const found = recorded(action);
			const event = found.at(-1)!;
			expect(event.type, type).toBe(type);
			expect(event.data, type).toEqual(data());
		}
	});

	it('records realm.created with the config, and realm.deleted with the Labours it took', () => {
		let realmId = 0;
		const created = expectOneEvent(
			() => (realmId = createRealm(db, actor, { name: 'Amber', key: 'AM', initialState: TODO }).id)
		);
		expect(created).toMatchObject({
			type: 'realm.created',
			data: { realm: json(readRealm(db, realmId)) }
		});
		const a = seedLabour(db, { realmId });
		const b = seedLabour(db, { realmId, parentId: a.id });

		const deleted = expectOneEvent(() => deleteRealm(db, actor, realmId));

		expect(deleted).toMatchObject({
			type: 'realm.deleted',
			data: { realmId, labourIds: [a.id, b.id] }
		});
	});

	it('records the new key of every Labour in a Realm whose key is renamed', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });

		const found = recorded(() => renameRealmKey(db, actor, realm.id, 'AB'));

		expect(shape(found)).toEqual([
			['realm.updated', { realm: json(readRealm(db, realm.id)) }],
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

	it("records each Labour a State's first Substate takes in, with its updatedAt moved", () => {
		const realm = seedRealm(db, 'AM');
		const todo = realm.initialStateId!;
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		db.update(labours)
			.set({ updatedAt: new Date(0) })
			.run();
		let substateId = 0;

		const found = recorded(() => (substateId = createSubstate(db, actor, todo, style('rev')).id));

		expect(shape(found)).toEqual([
			['substate.created', { realm: json(readRealm(db, realm.id)), stateId: todo, substateId }],
			['labour.updated', { labour: json(readLabour(db, a.id)) }],
			['labour.updated', { labour: json(readLabour(db, b.id)) }]
		]);
		expect(readLabour(db, a.id)).toMatchObject({ substateId });
		expect(readLabour(db, a.id).updatedAt.getTime()).toBeGreaterThan(0);
	});

	it('deletes the Quests of a deleted Realm, one quest.deleted each, and spares the Labours they listed', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const kept = seedLabour(db, { realmId: bl.id });
		const quest = createQuest(db, actor, { realmId: am.id, name: 'Q', ownerId: actor.id });
		addQuestLabour(db, actor, quest.id, kept.id);

		const found = recorded(() => deleteRealm(db, actor, am.id));

		expect(shape(found).map(([type]) => type)).toEqual(['realm.deleted', 'quest.deleted']);
		expect(found[1].data).toEqual({ id: quest.id, realmId: am.id });
		expect(readLabour(db, kept.id).id).toBe(kept.id);
	});

	it('records the Children it detaches in other Realms and the Quests it shrinks when deleting a Realm', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const parent = seedLabour(db, { realmId: am.id });
		const child = seedLabour(db, { realmId: bl.id, parentId: parent.id });
		const quest = createQuest(db, actor, {
			realmId: bl.id,
			name: 'Launch',
			ownerId: actor.id
		});
		addQuestLabour(db, actor, quest.id, parent.id);
		addQuestLabour(db, actor, quest.id, child.id);
		db.update(labours)
			.set({ updatedAt: new Date(0) })
			.run();
		db.update(quests)
			.set({ updatedAt: new Date(0) })
			.run();

		const found = recorded(() => deleteRealm(db, actor, am.id));

		const after = readQuest(db, quest.id);
		expect(shape(found)).toEqual([
			['realm.deleted', { realmId: am.id, labourIds: [parent.id] }],
			['labour.reparented', { labour: json(readLabour(db, child.id)) }],
			['quest.labours_removed', { quest: json(after), labourIds: [parent.id] }]
		]);
		expect(readLabour(db, child.id).parentId).toBeNull();
		expect(readLabour(db, child.id).updatedAt.getTime()).toBeGreaterThan(0);
		expect(after.progress).toEqual({ closed: 0, total: 1 });
		expect(after.updatedAt.getTime()).toBeGreaterThan(0);
	});
});

describe('Labour writes', () => {
	it('record one Event each, carrying the Labour with its current key', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const ownerId = seedUser(db, 'ada');
		const parent = seedLabour(db, { realmId: bl.id, ownerId });
		let labourId = 0;
		const labour = () => ({ labour: json(readLabour(db, labourId)) });

		const created = expectOneEvent(
			() => (labourId = createLabour(db, actor, { realmId: am.id, title: 'Fix', ownerId }).id)
		);
		expect(created).toMatchObject({ type: 'labour.created', data: labour() });
		expect(labour().labour).toMatchObject({ key: 'AM-1', closed: false });

		const updated = expectOneEvent(() => updateLabour(db, actor, labourId, { title: 'Fixed' }));
		expect(updated).toMatchObject({ type: 'labour.updated', data: labour() });

		const reparented = expectOneEvent(() => setParent(db, actor, labourId, parent.id));
		expect(reparented).toMatchObject({ type: 'labour.reparented', data: labour() });

		const moved = expectOneEvent(() => moveLabour(db, actor, labourId, { realmId: bl.id }));
		expect(moved).toMatchObject({ type: 'labour.moved', data: labour() });
		expect(labour().labour).toMatchObject({ key: 'BL-2', realmId: bl.id });
	});

	it('records a rank change as just the Labour, its State and its new Rank', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id });

		const ranked = expectOneEvent(() => rankLabour(db, actor, a.id, 'bottom'));

		expect(ranked).toMatchObject({
			type: 'labour.ranked',
			data: { id: a.id, stateId: a.stateId, rank: readLabour(db, a.id).rank }
		});
		expect(Object.keys(ranked.data).sort()).toEqual(['id', 'rank', 'stateId']);
	});

	it('records an update that changes only the Rank as labour.ranked', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id });

		const ranked = expectOneEvent(() =>
			updateLabour(db, actor, a.id, { title: a.title, stateId: a.stateId, placement: 'bottom' })
		);

		expect(shape([ranked])).toEqual([
			['labour.ranked', { id: a.id, stateId: a.stateId, rank: readLabour(db, a.id).rank }]
		]);
		expect(readLabour(db, a.id).updatedAt).toEqual(a.updatedAt);
	});

	it('records an update that changes the Rank with another field as labour.updated', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id });

		const updated = expectOneEvent(() =>
			updateLabour(db, actor, a.id, { title: 'Renamed', placement: 'bottom' })
		);

		expect(shape([updated])).toEqual([['labour.updated', { labour: json(readLabour(db, a.id)) }]]);
	});

	it('records the Children it detaches and the Quests it shrinks when deleting a Labour', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const parent = seedLabour(db, { realmId: am.id });
		const near = seedLabour(db, { realmId: am.id, parentId: parent.id });
		const far = seedLabour(db, { realmId: bl.id, parentId: parent.id });
		const first = createQuest(db, actor, {
			realmId: anyRealmId(db),
			name: 'One',
			ownerId: actor.id
		});
		const second = createQuest(db, actor, {
			realmId: anyRealmId(db),
			name: 'Two',
			ownerId: actor.id
		});
		addQuestLabour(db, actor, first.id, parent.id);
		addQuestLabour(db, actor, second.id, far.id);
		addQuestLabour(db, actor, second.id, parent.id);
		db.update(quests)
			.set({ updatedAt: new Date(0) })
			.run();

		const found = recorded(() => deleteLabour(db, actor, parent.id));

		expect(shape(found)).toEqual([
			['labour.deleted', { id: parent.id, realmId: am.id }],
			['labour.reparented', { labour: json(readLabour(db, near.id)) }],
			['labour.reparented', { labour: json(readLabour(db, far.id)) }],
			['quest.labours_removed', { quest: json(readQuest(db, first.id)), labourIds: [parent.id] }],
			['quest.labours_removed', { quest: json(readQuest(db, second.id)), labourIds: [parent.id] }]
		]);
		expect(readLabour(db, far.id).parentId).toBeNull();
		expect(readQuest(db, first.id).updatedAt.getTime()).toBeGreaterThan(0);
	});
});

describe('Quest writes', () => {
	it('record one Event each, carrying the Quest with its member Labours in order', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		const c = seedLabour(db, { realmId: bl.id, parentId: b.id });
		let questId = 0;
		const quest = () => json(readQuest(db, questId));

		const cases: [string, () => unknown, () => object][] = [
			[
				'quest.created',
				() =>
					(questId = createQuest(db, actor, {
						realmId: anyRealmId(db),
						name: 'Launch',
						ownerId: actor.id
					}).id),
				() => ({ quest: quest() })
			],
			[
				'quest.updated',
				() => updateQuest(db, actor, questId, { name: 'Ship' }),
				() => ({ quest: quest() })
			],
			[
				'quest.labours_added',
				() => addQuestLabour(db, actor, questId, a.id),
				() => ({ quest: quest(), labourIds: [a.id] })
			],
			[
				'quest.labours_added',
				() => addQuestLabourWithChildren(db, actor, questId, b.id),
				() => ({ quest: quest(), labourIds: [b.id, c.id] })
			],
			[
				'quest.labour_ranked',
				() => rankQuestLabour(db, actor, questId, a.id, 'bottom'),
				() => ({ quest: quest(), labourId: a.id })
			],
			[
				'quest.labours_removed',
				() => removeQuestLabour(db, actor, questId, a.id),
				() => ({ quest: quest(), labourIds: [a.id] })
			]
		];
		for (const [type, action, data] of cases) {
			const event = expectOneEvent(action);
			expect(event.type, type).toBe(type);
			expect(event.data, type).toEqual(data());
		}
		expect(quest().labours.map((t: { id: number }) => t.id)).toEqual([b.id, c.id]);

		const deleted = expectOneEvent(() => deleteQuest(db, actor, questId));
		expect(deleted).toMatchObject({ type: 'quest.deleted', data: { id: questId } });
	});
});

describe('bulk Quest membership', () => {
	it('records one Event per call, naming only the Labours that changed', () => {
		const realm = seedRealm(db, 'AM');
		const [a, b, c] = [1, 2, 3].map(() => seedLabour(db, { realmId: realm.id }));
		const questId = createQuest(db, actor, {
			realmId: anyRealmId(db),
			name: 'Launch',
			ownerId: actor.id
		}).id;
		addQuestLabour(db, actor, questId, b.id);
		const quest = () => json(readQuest(db, questId));

		const added = recorded(() => addQuestLabours(db, actor, questId, [a.id, b.id, c.id]));
		expect(shape(added)).toEqual([
			['quest.labours_added', { quest: quest(), labourIds: [a.id, c.id] }]
		]);

		const removed = recorded(() => removeQuestLabours(db, actor, questId, [c.id, a.id]));
		expect(shape(removed)).toEqual([
			['quest.labours_removed', { quest: quest(), labourIds: [c.id, a.id] }]
		]);
	});

	it('records no Event when every Labour is skipped', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const questId = createQuest(db, actor, {
			realmId: anyRealmId(db),
			name: 'Launch',
			ownerId: actor.id
		}).id;
		addQuestLabour(db, actor, questId, a.id);

		const found = recorded(() => {
			addQuestLabours(db, actor, questId, [a.id]);
			removeQuestLabours(db, actor, questId, [seedLabour(db, { realmId: realm.id }).id]);
		});

		expect(found.filter((e) => e.type.startsWith('quest.'))).toEqual([]);
	});

	it('records nothing when a Labour is unknown', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const questId = createQuest(db, actor, {
			realmId: anyRealmId(db),
			name: 'Launch',
			ownerId: actor.id
		}).id;

		const found = recorded(() =>
			expect(() => addQuestLabours(db, actor, questId, [a.id, 999])).toThrow(DomainError)
		);

		expect(found).toEqual([]);
	});
});

describe('no-op writes', () => {
	it('records no Event for a write that changes nothing', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Same' });

		const found = recorded(() => {
			updateRealm(db, actor, realm.id, { name: realm.name });
			renameRealmKey(db, actor, realm.id, 'am');
			setInitialState(db, actor, realm.id, realm.initialStateId!);
			updateState(db, actor, realm.initialStateId!, { label: TODO.label });
			moveState(db, actor, realm.initialStateId!, 0);
			updateLabour(db, actor, labour.id, { title: 'Same', stateId: labour.stateId });
			setParent(db, actor, labour.id, null);
		});

		expect(found).toEqual([]);
	});
});

describe('failed writes', () => {
	it('leaves no Event and publishes nothing when a write is refused', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		const found = recorded(() => {
			for (const action of [
				() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId: 999 }),
				() => setParent(db, actor, labour.id, labour.id),
				() => deleteState(db, actor, listStates(db, realm.id).at(-1)!.id),
				() => renameRealmKey(db, actor, realm.id, '1')
			]) {
				expect(action).toThrow(DomainError);
			}
		});

		expect(found).toEqual([]);
	});

	it('rolls back the write with its Events when recording them fails', () => {
		const realm = seedRealm(db, 'AM');
		const ghost = { id: 999 };
		const before = db.select().from(labours).all();

		const found = recorded(() =>
			expect(() =>
				createLabour(db, ghost, { realmId: realm.id, title: 'x', ownerId: actor.id })
			).toThrow()
		);

		expect(found).toEqual([]);
		expect(db.select().from(labours).all()).toEqual(before);
	});
});

describe('publishing', () => {
	it("publishes a write's Events after its commit, with consecutive seqs, as stored", () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const parent = seedLabour(db, { realmId: am.id });
		seedLabour(db, { realmId: bl.id, parentId: parent.id });
		const inside: boolean[] = [];
		const stop = subscribe(() => inside.push(db.$client.inTransaction));

		const found = recorded(() => deleteRealm(db, actor, am.id));
		stop();

		expect(found.length).toBeGreaterThan(1);
		expect(inside).toEqual(found.map(() => false));
		const first = found[0].seq;
		expect(found.map((e) => e.seq)).toEqual(found.map((_, i) => first + i));
	});
});
