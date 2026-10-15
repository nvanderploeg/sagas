import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	createProject,
	deleteProject,
	readBoard,
	readProject,
	renameProjectKey
} from '#lib/server/domain/projects.ts';
import {
	addQuestTicket,
	addQuestTicketWithChildren,
	createQuest,
	deleteQuest,
	rankQuestTicket,
	removeQuestTicket,
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
	createTicket,
	deleteTicket,
	moveTicket,
	rankTicket,
	setParent,
	updateTicket
} from '#lib/server/domain/tickets.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { eventsSince, readAtSeq } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedUser, TODO } from '#lib/server/test/fixtures.ts';
import {
	readHome,
	readQuestList,
	readQuestPage,
	readTicketPage,
	toJson
} from '#lib/server/ui/reads.ts';
import {
	applyToBoard,
	applyToHome,
	applyToQuestList,
	applyToQuestPage,
	applyToSettings,
	applyToTicketPage,
	byRank,
	type Apply
} from './apply.ts';
import { FeedCore, LiveCore } from './core.ts';
import type { BoardView, LiveEvent } from './types.ts';

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
		tickets: [...board.tickets].sort((a, b) =>
			a.stateId !== b.stateId ? a.stateId - b.stateId : byRank(a, b)
		)
	};

describe('the client views, fed by the Stream', () => {
	it('equal a fresh load after every write of the replica scenario', () => {
		const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
		const project = (key: string) =>
			createProject(db, actor, { name: key, key, initialState: TODO });
		const ticket = (projectId: number, parentId: number | null = null) =>
			createTicket(db, actor, { projectId, title: 't', ownerId: actor.id, parentId });
		const other = seedUser(db, 'other');
		const am = project('AM');
		const bl = project('BL');
		const cc = project('CC');
		const quest = createQuest(db, actor, { name: 'Launch', ownerId: actor.id });
		const closedOf = (projectId: number) => listStates(db, projectId).find((s) => s.isClosed)!.id;

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
			view(feed, 'settings AM', (tx) => ({ project: readProject(tx, am.id) }), applyToSettings)
		];

		let a = 0;
		let b = 0;
		let c = 0;
		let d = 0;
		let e = 0;
		const writes: [string, () => unknown][] = [
			[
				'create Tickets across Projects',
				() => {
					a = ticket(am.id).id;
					b = ticket(bl.id, a).id;
					c = ticket(cc.id, a).id;
					d = ticket(am.id).id;
					e = ticket(am.id, d).id;
				}
			],
			[
				'open Ticket pages',
				() => {
					for (const id of [a, b, d, e]) {
						probes.push(
							view(feed, `ticket ${id}`, (tx) => readTicketPage(tx, id), applyToTicketPage)
						);
					}
				}
			],
			['add to the Quest', () => addQuestTicket(db, actor, quest.id, a)],
			['add with Children', () => addQuestTicketWithChildren(db, actor, quest.id, d)],
			['add across Projects', () => addQuestTicket(db, actor, quest.id, c, 'top')],
			['a second Quest', () => createQuest(db, actor, { name: 'Other', ownerId: other })],
			['edit a member', () => updateTicket(db, actor, a, { title: 'renamed' })],
			['assign away', () => updateTicket(db, actor, b, { assigneeId: other })],
			['hand over', () => updateTicket(db, actor, b, { ownerId: other })],
			['close a member', () => updateTicket(db, actor, d, { stateId: closedOf(am.id) })],
			['first Substate', () => createSubstate(db, actor, am.initialStateId!, style('review'))],
			['add a State', () => createState(db, actor, am.id, style('doing'))],
			['move a State', () => moveState(db, actor, listStates(db, am.id)[1].id, 0)],
			['restyle a State', () => updateState(db, actor, am.initialStateId!, { label: 'Next' })],
			['rank a member', () => rankTicket(db, actor, e, 'top')],
			['a new Child', () => ticket(bl.id, d)],
			['rename a Project key', () => renameProjectKey(db, actor, am.id, 'AX')],
			['move a Parent across Projects', () => moveTicket(db, actor, a, { projectId: bl.id })],
			['move a Child across Projects', () => moveTicket(db, actor, e, { projectId: cc.id })],
			['reparent', () => setParent(db, actor, d, b)],
			['clear a Parent', () => setParent(db, actor, c, null)],
			['rank in the Quest', () => rankQuestTicket(db, actor, quest.id, a, 'top')],
			['remove from the Quest', () => removeQuestTicket(db, actor, quest.id, e)],
			['delete a Parent and member', () => deleteTicket(db, actor, d)],
			['delete a Project', () => deleteProject(db, actor, bl.id)],
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
