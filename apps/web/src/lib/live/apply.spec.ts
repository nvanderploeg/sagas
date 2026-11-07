import { beforeEach, describe, expect, it } from 'vitest';
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
import { seedActor, seedUser, TODO, anyRealmId } from '#lib/server/test/fixtures.ts';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

async function loadOrNull<T>(read: (tx: Handle) => T): Promise<{ seq: number; value: T } | null> {
	try {
		const loaded = await readAtSeq(db, read);
		return { seq: loaded.seq, value: toJson(loaded.value) as T };
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') return null;
		throw error;
	}
}

type Probe = { name: string; check: () => Promise<void> };

// A client view: loaded with its seq, attached to the Feed, reloaded when it asks.
async function view<T>(
	feed: FeedCore,
	name: string,
	read: (tx: Handle) => unknown,
	apply: Apply<T>,
	normal: (value: T | null) => unknown = (v) => v
): Promise<Probe> {
	const loaded = (await loadOrNull(read))!;
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
		async check() {
			if (reload) {
				reload = false;
				const fresh = await loadOrNull(read);
				if (fresh) core.load(fresh.value as T, fresh.seq);
			}
			const fresh = await loadOrNull(read);
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
	it('equal a fresh load after every write of the replica scenario', async () => {
		const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
		const realm = (key: string) => createRealm(db, actor, { name: key, key, initialState: TODO });
		const labour = (realmId: number, parentId: number | null = null) =>
			createLabour(db, actor, { realmId, title: 't', ownerId: actor.id, parentId });
		const other = await seedUser(db, 'other');
		let firstComment = 0;
		let secondComment = 0;
		const am = await realm('AM');
		const bl = await realm('BL');
		const cc = await realm('CC');
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Launch',
			ownerId: actor.id
		});
		const closedOf = async (realmId: number) =>
			(await listStates(db, realmId)).find((s) => s.isClosed)!.id;

		const feed = new FeedCore();
		feed.start(0);
		let pushed = 0;
		const deliver = async () => {
			for (const event of toJson(await eventsSince(db, pushed)) as LiveEvent[]) {
				feed.push(event);
				pushed = event.seq;
			}
		};

		const probes: Probe[] = [
			...(await Promise.all(
				[am, bl, cc].map((p) =>
					view(feed, `board ${p.key}`, (tx) => readBoard(tx, p.id), applyToBoard(p.id), boardOrder)
				)
			)),
			await view(feed, 'quest page', (tx) => readQuestPage(tx, actor, quest.id), applyToQuestPage),
			await view(feed, 'quest list', (tx) => readQuestList(tx, actor), applyToQuestList),
			await view(feed, 'home', (tx) => readHome(tx, actor), applyToHome(actor.id)),
			await view(
				feed,
				'settings AM',
				async (tx) => ({ realm: await readRealm(tx, am.id) }),
				applyToSettings
			)
		];

		let a = 0;
		let b = 0;
		let c = 0;
		let d = 0;
		let e = 0;
		const writes: [string, () => unknown][] = [
			[
				'create Labours across Realms',
				async () => {
					a = (await labour(am.id)).id;
					b = (await labour(bl.id, a)).id;
					c = (await labour(cc.id, a)).id;
					d = (await labour(am.id)).id;
					e = (await labour(am.id, d)).id;
				}
			],
			[
				'open Labour pages',
				async () => {
					for (const id of [a, b, d, e]) {
						probes.push(
							await view(
								feed,
								`labour ${id}`,
								(tx) => readLabourPage(tx, actor, id),
								applyToLabourPage
							)
						);
					}
				}
			],
			['add to the Quest', () => addQuestLabour(db, actor, quest.id, a)],
			['add with Children', () => addQuestLabourWithChildren(db, actor, quest.id, d)],
			['add across Realms', () => addQuestLabour(db, actor, quest.id, c, 'top')],
			[
				'a second Quest',
				async () =>
					createQuest(db, actor, { realmId: await anyRealmId(db), name: 'Other', ownerId: other })
			],
			['edit a member', () => updateLabour(db, actor, a, { title: 'renamed' })],
			['assign away', () => updateLabour(db, actor, b, { assigneeId: other })],
			['hand over', () => updateLabour(db, actor, b, { ownerId: other })],
			[
				'close a member',
				async () => updateLabour(db, actor, d, { stateId: await closedOf(am.id) })
			],
			['first Substate', () => createSubstate(db, actor, am.initialStateId!, style('review'))],
			['add a State', () => createState(db, actor, am.id, style('doing'))],
			['move a State', async () => moveState(db, actor, (await listStates(db, am.id))[1].id, 0)],
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
			['comment', async () => (firstComment = (await addComment(db, actor, a, 'first')).id)],
			[
				'comment on a Child',
				async () => (secondComment = (await addComment(db, { id: other }, d, 'second')).id)
			],
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
			await run();
			await deliver();
			for (const probe of probes) {
				try {
					await probe.check();
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
	it('hands back the same board for every Event about another Realm', async () => {
		const am = await createRealm(db, actor, { name: 'AM', key: 'AM', initialState: TODO });
		const bl = await createRealm(db, actor, { name: 'BL', key: 'BL', initialState: TODO });
		await createLabour(db, actor, { realmId: am.id, title: 'here', ownerId: actor.id });
		const loaded = (await loadOrNull((tx) => readBoard(tx, am.id)))!;
		const style = { key: 'doing', label: 'Doing', color: '#000000', icon: 'dot' };

		const there = await createLabour(db, actor, {
			realmId: bl.id,
			title: 'there',
			ownerId: actor.id
		});
		const sibling = await createLabour(db, actor, {
			realmId: bl.id,
			title: 'x',
			ownerId: actor.id
		});
		await updateLabour(db, actor, there.id, { title: 'renamed' });
		await updateLabour(db, actor, there.id, { placement: 'top' });
		await rankLabour(db, actor, sibling.id, 'top');
		await setParent(db, actor, sibling.id, there.id);
		await createState(db, actor, bl.id, style);
		const quest = await createQuest(db, actor, {
			realmId: await anyRealmId(db),
			name: 'Q',
			ownerId: actor.id
		});
		await addQuestLabour(db, actor, quest.id, there.id);
		await renameRealmKey(db, actor, bl.id, 'BX');
		await deleteLabour(db, actor, sibling.id);
		await deleteRealm(db, actor, bl.id);

		const events = toJson(await eventsSince(db, loaded.seq)) as LiveEvent[];
		expect(new Set(events.map((e) => e.type)).size).toBeGreaterThan(8);
		const board = loaded.value as unknown as BoardView;
		const apply = applyToBoard(am.id);
		for (const event of events) expect(apply(board, event), event.type).toBe(board);
	});
});

describe('applyToLabourPage', () => {
	it("applies one's own new Parent from the view it shows, and reloads for any other", async () => {
		const am = await createRealm(db, actor, { name: 'AM', key: 'AM', initialState: TODO });
		const labour = (title: string) =>
			createLabour(db, actor, { realmId: am.id, title, ownerId: actor.id });
		const [kid, a, b] = [await labour('kid'), await labour('a'), await labour('b')];
		const loaded = (await loadOrNull((tx) => readLabourPage(tx, actor, kid.id)))!;
		const page = loaded.value as unknown as LabourPageView;
		await setParent(db, actor, kid.id, a.id);
		const [event] = toJson(await eventsSince(db, loaded.seq)) as LiveEvent[];
		const parent = async (id: number) => toJson(await readLabour(db, id)) as Labour;
		const showing = (p: Labour) => ({
			...page,
			labour: { ...page.labour, parentId: p.id },
			parent: p
		});

		expect(applyToLabourPage(page, event)).toBe(RELOAD);
		expect(applyToLabourPage(page, event, showing(await parent(b.id)))).toBe(RELOAD);
		expect(applyToLabourPage(page, event, showing(await parent(a.id)))).toMatchObject({
			labour: { id: kid.id, parentId: a.id },
			parent: await parent(a.id)
		});
	});
});
