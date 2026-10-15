import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { addComment, deleteComment, editComment } from '#lib/server/domain/comments.ts';
import {
	createRealm,
	deleteRealm,
	readBoard,
	readRealm,
	renameRealmKey
} from '#lib/server/domain/realms.ts';
import {
	addQuestLabour,
	addQuestLabourWithChildren,
	createQuest,
	deleteQuest,
	rankQuestLabour,
	removeQuestLabour,
	updateQuest
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
	readLabour,
	setParent,
	updateLabour
} from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { eventsSince, readAtSeq } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedUser, TODO } from '#lib/server/test/fixtures.ts';
import {
	readHome,
	readQuestList,
	readQuestPage,
	readLabourPage,
	toJson
} from '#lib/server/ui/reads.ts';
import {
	applyToBoard,
	applyToHome,
	applyToQuestList,
	applyToQuestPage,
	applyToSettings,
	applyToLabourPage,
	byRank,
	RELOAD,
	type Apply
} from './apply.ts';
import { FeedCore, LiveCore } from './core.ts';
import type { BoardView, LiveEvent, Labour, LabourPageView } from './types.ts';

// The scenario of events/replica.spec.ts, run through the client's own views and Feed.

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

function loadOrNull<T>(read: (tx: Handle) => T): { seq: number; value: T } | null {
	try {
		const loaded = readAtSeq(db, read);
		return { seq: loaded.seq, value: toJson(loaded.value) as T };
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') return null;
		throw error;
	}
}

type Probe = { name: string; check: () => void };

// A client view: loaded with its seq, attached to the Feed, reloaded when it asks.
function view<T>(
	feed: FeedCore,
	name: string,
	read: (tx: Handle) => unknown,
	apply: Apply<T>,
	normal: (value: T | null) => unknown = (v) => v
): Probe {
	const loaded = loadOrNull(read)!;
	let reload = false;
	const core = new LiveCore<T>({
		seq: loaded.seq,
		value: loaded.value as T,
		apply,
		onReload: () => (reload = true)
	});
	core.connect(feed);
	return {
		name,
		check() {
			if (reload) {
				reload = false;
				const fresh = loadOrNull(read);
				if (fresh) core.load(fresh.value as T, fresh.seq);
			}
			const fresh = loadOrNull(read);
			expect(normal(core.value), name).toEqual(normal((fresh?.value as T) ?? null));
		}
	};
}

const boardOrder = (board: BoardView | null) =>
	board && {
		...board,
		labours: [...board.labours].sort((a, b) =>
			a.stateId !== b.stateId ? a.stateId - b.stateId : byRank(a, b)
		)
	};

describe('the client views, fed by the Stream', () => {
	it('equal a fresh load after every write of the replica scenario', () => {
		const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
		const realm = (key: string) => createRealm(db, actor, { name: key, key, initialState: TODO });
		const labour = (realmId: number, parentId: number | null = null) =>
			createLabour(db, actor, { realmId, title: 't', ownerId: actor.id, parentId });
		const other = seedUser(db, 'other');
		let firstComment = 0;
		let secondComment = 0;
		const am = realm('AM');
		const bl = realm('BL');
		const cc = realm('CC');
		const quest = createQuest(db, actor, { name: 'Launch', ownerId: actor.id });
		const closedOf = (realmId: number) => listStates(db, realmId).find((s) => s.isClosed)!.id;

		const feed = new FeedCore();
		feed.start(0);
		let pushed = 0;
		const deliver = () => {
			for (const event of toJson(eventsSince(db, pushed)) as LiveEvent[]) {
				feed.push(event);
				pushed = event.seq;
			}
		};

		const probes: Probe[] = [
			...[am, bl, cc].map((p) =>
				view(feed, `board ${p.key}`, (tx) => readBoard(tx, p.id), applyToBoard(p.id), boardOrder)
			),
			view(feed, 'quest page', (tx) => readQuestPage(tx, quest.id), applyToQuestPage),
			view(feed, 'quest list', (tx) => readQuestList(tx), applyToQuestList),
			view(feed, 'home', (tx) => readHome(tx, actor.id), applyToHome(actor.id)),
			view(feed, 'settings AM', (tx) => ({ realm: readRealm(tx, am.id) }), applyToSettings)
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
			[
				'open Labour pages',
				() => {
					for (const id of [a, b, d, e]) {
						probes.push(
							view(feed, `labour ${id}`, (tx) => readLabourPage(tx, id), applyToLabourPage)
						);
					}
				}
			],
			['add to the Quest', () => addQuestLabour(db, actor, quest.id, a)],
			['add with Children', () => addQuestLabourWithChildren(db, actor, quest.id, d)],
			['add across Realms', () => addQuestLabour(db, actor, quest.id, c, 'top')],
			['a second Quest', () => createQuest(db, actor, { name: 'Other', ownerId: other })],
			['edit a member', () => updateLabour(db, actor, a, { title: 'renamed' })],
			['assign away', () => updateLabour(db, actor, b, { assigneeId: other })],
			['hand over', () => updateLabour(db, actor, b, { ownerId: other })],
			['close a member', () => updateLabour(db, actor, d, { stateId: closedOf(am.id) })],
			['first Substate', () => createSubstate(db, actor, am.initialStateId!, style('review'))],
			['add a State', () => createState(db, actor, am.id, style('doing'))],
			['move a State', () => moveState(db, actor, listStates(db, am.id)[1].id, 0)],
			['restyle a State', () => updateState(db, actor, am.initialStateId!, { label: 'Next' })],
			['rank a member', () => rankLabour(db, actor, e, 'top')],
			['rank through an update', () => updateLabour(db, actor, a, { placement: 'top' })],
			['a new Child', () => labour(bl.id, d)],
			['rename a Realm key', () => renameRealmKey(db, actor, am.id, 'AX')],
			['move a Parent across Realms', () => moveLabour(db, actor, a, { realmId: bl.id })],
			['move a Child across Realms', () => moveLabour(db, actor, e, { realmId: cc.id })],
			['reparent', () => setParent(db, actor, d, b)],
			['clear a Parent', () => setParent(db, actor, c, null)],
			['rank in the Quest', () => rankQuestLabour(db, actor, quest.id, a, 'top')],
			['comment', () => (firstComment = addComment(db, actor, a, 'first').id)],
			['comment on a Child', () => (secondComment = addComment(db, { id: other }, d, 'second').id)],
			['edit a comment', () => editComment(db, actor, firstComment, 'edited')],
			['delete a comment', () => deleteComment(db, { id: other }, secondComment)],
			['remove from the Quest', () => removeQuestLabour(db, actor, quest.id, e)],
			['delete a Parent and member', () => deleteLabour(db, actor, d)],
			['delete a Realm', () => deleteRealm(db, actor, bl.id)],
			['edit the Quest', () => updateQuest(db, actor, quest.id, { name: 'Ship' })],
			['give the Quest away', () => updateQuest(db, actor, quest.id, { ownerId: other })],
			['delete the Quest', () => deleteQuest(db, actor, quest.id)]
		];

		for (const [step, run] of writes) {
			run();
			deliver();
			for (const probe of probes) {
				try {
					probe.check();
				} catch (error) {
					throw new Error(`${probe.name} after ${step}: ${(error as Error).message}`, {
						cause: error
					});
				}
			}
		}
	});
});

describe('applyToBoard', () => {
	it('hands back the same board for every Event about another Realm', () => {
		const am = createRealm(db, actor, { name: 'AM', key: 'AM', initialState: TODO });
		const bl = createRealm(db, actor, { name: 'BL', key: 'BL', initialState: TODO });
		createLabour(db, actor, { realmId: am.id, title: 'here', ownerId: actor.id });
		const loaded = loadOrNull((tx) => readBoard(tx, am.id))!;
		const style = { key: 'doing', label: 'Doing', color: '#000000', icon: 'dot' };

		const there = createLabour(db, actor, { realmId: bl.id, title: 'there', ownerId: actor.id });
		const sibling = createLabour(db, actor, { realmId: bl.id, title: 'x', ownerId: actor.id });
		updateLabour(db, actor, there.id, { title: 'renamed' });
		updateLabour(db, actor, there.id, { placement: 'top' });
		rankLabour(db, actor, sibling.id, 'top');
		setParent(db, actor, sibling.id, there.id);
		createState(db, actor, bl.id, style);
		const quest = createQuest(db, actor, { name: 'Q', ownerId: actor.id });
		addQuestLabour(db, actor, quest.id, there.id);
		renameRealmKey(db, actor, bl.id, 'BX');
		deleteLabour(db, actor, sibling.id);
		deleteRealm(db, actor, bl.id);

		const events = toJson(eventsSince(db, loaded.seq)) as LiveEvent[];
		expect(new Set(events.map((e) => e.type)).size).toBeGreaterThan(8);
		const board = loaded.value as unknown as BoardView;
		const apply = applyToBoard(am.id);
		for (const event of events) expect(apply(board, event), event.type).toBe(board);
	});
});

describe('applyToLabourPage', () => {
	it("applies one's own new Parent from the view it shows, and reloads for any other", () => {
		const am = createRealm(db, actor, { name: 'AM', key: 'AM', initialState: TODO });
		const labour = (title: string) =>
			createLabour(db, actor, { realmId: am.id, title, ownerId: actor.id });
		const [kid, a, b] = [labour('kid'), labour('a'), labour('b')];
		const loaded = loadOrNull((tx) => readLabourPage(tx, kid.id))!;
		const page = loaded.value as unknown as LabourPageView;
		setParent(db, actor, kid.id, a.id);
		const [event] = toJson(eventsSince(db, loaded.seq)) as LiveEvent[];
		const parent = (id: number) => toJson(readLabour(db, id)) as Labour;
		const showing = (p: Labour) => ({
			...page,
			labour: { ...page.labour, parentId: p.id },
			parent: p
		});

		expect(applyToLabourPage(page, event)).toBe(RELOAD);
		expect(applyToLabourPage(page, event, showing(parent(b.id)))).toBe(RELOAD);
		expect(applyToLabourPage(page, event, showing(parent(a.id)))).toMatchObject({
			labour: { id: kid.id, parentId: a.id },
			parent: parent(a.id)
		});
	});
});
