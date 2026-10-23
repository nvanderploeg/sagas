import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	createRealm,
	deleteRealm,
	readBoard,
	renameRealmKey,
	type BoardView
} from '#lib/server/domain/realms.ts';
import {
	addQuestLabour,
	addQuestLabourWithChildren,
	createQuest,
	deleteQuest,
	rankQuestLabour,
	readQuest,
	removeQuestLabour,
	updateQuest,
	type QuestView
} from '#lib/server/domain/quests.ts';
import {
	createState,
	createSubstate,
	listStates,
	moveState,
	updateState
} from '#lib/server/domain/states.ts';
import {
	createLabour,
	deleteLabour,
	moveLabour,
	rankLabour,
	setParent,
	updateLabour
} from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, TODO, anyRealmId } from '#lib/server/test/fixtures.ts';
import { eventsSince, readAtSeq } from './log.ts';
import type { Json, SagasEvent } from './types.ts';

// A client per docs/events.md: it loads a view with its seq, then applies Events alone.

type Board = Json<BoardView>;
type Quest = Json<QuestView>;
type Member = Quest['labours'][number];

function applyToBoard(board: Board, realmId: number, event: Json<SagasEvent>): Board | null {
	const without = (ids: number[]) => board.labours.filter((t) => !ids.includes(t.id));
	switch (event.type) {
		case 'realm.created':
		case 'realm.updated':
		case 'state.created':
		case 'state.updated':
		case 'state.deleted':
		case 'substate.created':
		case 'substate.updated':
		case 'substate.deleted':
			return event.data.realm.id === realmId ? { ...board, realm: event.data.realm } : board;
		case 'realm.deleted':
			if (event.data.realmId === realmId) return null;
			return { ...board, labours: without(event.data.labourIds) };
		case 'labour.created':
		case 'labour.updated':
		case 'labour.moved':
		case 'labour.reparented': {
			const { labour } = event.data;
			const labours = without([labour.id]);
			return { ...board, labours: labour.realmId === realmId ? [...labours, labour] : labours };
		}
		case 'labour.ranked': {
			const { id, stateId, rank } = event.data;
			return {
				...board,
				labours: board.labours.map((t) => (t.id === id ? { ...t, stateId, rank } : t))
			};
		}
		case 'labour.rekeyed': {
			const keys = new Map(event.data.labours.map((t) => [t.id, t.key]));
			return {
				...board,
				labours: board.labours.map((t) => ({ ...t, key: keys.get(t.id) ?? t.key }))
			};
		}
		case 'labour.deleted':
			return { ...board, labours: without([event.data.id]) };
		default:
			return board;
	}
}

function applyToQuest(quest: Quest, event: Json<SagasEvent>): Quest | null {
	const members = (labours: Member[]): Quest => ({
		...quest,
		labours,
		progress: { closed: labours.filter((t) => t.closed).length, total: labours.length }
	});
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.labours_added':
		case 'quest.labours_removed':
		case 'quest.labour_ranked':
			return event.data.quest.id === quest.id ? event.data.quest : quest;
		case 'quest.deleted':
			return event.data.id === quest.id ? null : quest;
		case 'labour.updated':
		case 'labour.moved':
		case 'labour.reparented': {
			const { labour } = event.data;
			return members(quest.labours.map((t) => (t.id === labour.id ? labour : t)));
		}
		case 'labour.ranked': {
			const { id, stateId, rank } = event.data;
			return members(quest.labours.map((t) => (t.id === id ? { ...t, stateId, rank } : t)));
		}
		case 'labour.rekeyed': {
			const keys = new Map(event.data.labours.map((t) => [t.id, t.key]));
			return members(quest.labours.map((t) => ({ ...t, key: keys.get(t.id) ?? t.key })));
		}
		case 'labour.deleted':
			return members(quest.labours.filter((t) => t.id !== event.data.id));
		case 'realm.deleted':
			return members(quest.labours.filter((t) => !event.data.labourIds.includes(t.id)));
		default:
			return quest;
	}
}

// Board order: by State, then by Rank in code-unit order.
const boardOrder = (board: Board | null): Board | null =>
	board && {
		...board,
		labours: [...board.labours].sort((a, b) =>
			a.stateId !== b.stateId ? a.stateId - b.stateId : a.rank < b.rank ? -1 : 1
		)
	};

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const json = <T>(value: T): Json<T> => JSON.parse(JSON.stringify(value));

function loadOrNull<T>(read: (tx: Handle) => T): Json<T> | null {
	try {
		return json(read(db));
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') return null;
		throw error;
	}
}

function replica<T>(
	read: (tx: Handle) => T,
	apply: (view: Json<T>, e: Json<SagasEvent>) => Json<T> | null
) {
	const loaded = readAtSeq(db, read);
	let seq = loaded.seq;
	let view: Json<T> | null = json(loaded.value);
	return {
		// Feeds every Event from the start of the log: the client must drop those its load holds.
		catchUp() {
			for (const event of json(eventsSince(db, 0))) {
				if (event.seq <= seq) continue;
				seq = event.seq;
				if (view !== null) view = apply(view, event);
			}
			return view;
		}
	};
}

describe('a client applying Stream Events', () => {
	it('keeps its boards and its Quest view equal to a fresh load after every write', () => {
		const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
		const realm = (key: string) => createRealm(db, actor, { name: key, key, initialState: TODO });
		const labour = (realmId: number, parentId: number | null = null) =>
			createLabour(db, actor, { realmId, title: 't', ownerId: actor.id, parentId });
		const am = realm('AM');
		const bl = realm('BL');
		const cc = realm('CC');
		const quest = createQuest(db, actor, {
			realmId: anyRealmId(db),
			name: 'Launch',
			ownerId: actor.id
		});
		const closedOf = (realmId: number) => listStates(db, realmId).find((s) => s.isClosed)!.id;

		const views = [
			...[am, bl, cc].map((p) => ({
				name: `board ${p.key}`,
				replica: replica(
					(tx) => readBoard(tx, p.id),
					(view, e) => applyToBoard(view, p.id, e)
				),
				fresh: () => loadOrNull((tx) => readBoard(tx, p.id)),
				normal: boardOrder
			})),
			{
				name: 'quest',
				replica: replica((tx) => readQuest(tx, quest.id), applyToQuest),
				fresh: () => loadOrNull((tx) => readQuest(tx, quest.id)),
				normal: <T>(view: T) => view
			}
		];

		let a = 0;
		let b = 0;
		let c = 0;
		let d = 0;
		let e = 0;
		const writes: [string, () => unknown][] = [
			[
				'create Labours across Realms',
				() => {
					a = labour(am.id).id;
					b = labour(bl.id, a).id;
					c = labour(cc.id, a).id;
					d = labour(am.id).id;
					e = labour(am.id, d).id;
				}
			],
			['add to the Quest', () => addQuestLabour(db, actor, quest.id, a)],
			['add with Children', () => addQuestLabourWithChildren(db, actor, quest.id, d)],
			['add across Realms', () => addQuestLabour(db, actor, quest.id, c, 'top')],
			['edit a member', () => updateLabour(db, actor, a, { title: 'renamed' })],
			['close a member', () => updateLabour(db, actor, d, { stateId: closedOf(am.id) })],
			['first Substate', () => createSubstate(db, actor, am.initialStateId!, style('review'))],
			['add a State', () => createState(db, actor, am.id, style('doing'))],
			['move a State', () => moveState(db, actor, listStates(db, am.id)[1].id, 0)],
			['restyle a State', () => updateState(db, actor, am.initialStateId!, { label: 'Next' })],
			['rank a member', () => rankLabour(db, actor, e, 'top')],
			['rename a Realm key', () => renameRealmKey(db, actor, am.id, 'AX')],
			['move a Parent across Realms', () => moveLabour(db, actor, a, { realmId: bl.id })],
			['move a Child across Realms', () => moveLabour(db, actor, e, { realmId: cc.id })],
			['reparent', () => setParent(db, actor, d, b)],
			['rank in the Quest', () => rankQuestLabour(db, actor, quest.id, a, 'top')],
			['remove from the Quest', () => removeQuestLabour(db, actor, quest.id, e)],
			['delete a Parent and member', () => deleteLabour(db, actor, d)],
			['delete a Realm', () => deleteRealm(db, actor, bl.id)],
			['edit the Quest', () => updateQuest(db, actor, quest.id, { name: 'Ship' })],
			['delete the Quest', () => deleteQuest(db, actor, quest.id)]
		];

		for (const [step, run] of writes) {
			run();
			for (const view of views) {
				expect(view.normal(view.replica.catchUp() as never), `${view.name} after ${step}`).toEqual(
					view.fresh()
				);
			}
		}
		expect(views.map((v) => v.fresh() === null)).toEqual([false, true, false, true]);
	});
});

describe('readAtSeq', () => {
	it('reads the view and its seq in one transaction', () => {
		createRealm(db, actor, { name: 'AM', key: 'AM', initialState: TODO });
		let inside = false;

		const loaded = readAtSeq(db, () => (inside = db.$client.inTransaction));

		expect(inside).toBe(true);
		expect(loaded.seq).toBe(eventsSince(db, 0).at(-1)!.seq);
	});
});
