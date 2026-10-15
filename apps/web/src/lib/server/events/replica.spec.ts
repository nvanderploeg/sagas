import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	createProject,
	deleteProject,
	readBoard,
	renameProjectKey,
	type BoardView
} from '#lib/server/domain/projects.ts';
import {
	addQuestTicket,
	addQuestTicketWithChildren,
	createQuest,
	deleteQuest,
	rankQuestTicket,
	readQuest,
	removeQuestTicket,
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
	createTicket,
	deleteTicket,
	moveTicket,
	rankTicket,
	setParent,
	updateTicket
} from '#lib/server/domain/tickets.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, TODO } from '#lib/server/test/fixtures.ts';
import { eventsSince, readAtSeq } from './log.ts';
import type { Json, WorkloadEvent } from './types.ts';

// A client per docs/events.md: it loads a view with its seq, then applies Events alone.

type Board = Json<BoardView>;
type Quest = Json<QuestView>;
type Member = Quest['tickets'][number];

function applyToBoard(board: Board, projectId: number, event: Json<WorkloadEvent>): Board | null {
	const without = (ids: number[]) => board.tickets.filter((t) => !ids.includes(t.id));
	switch (event.type) {
		case 'project.created':
		case 'project.updated':
		case 'state.created':
		case 'state.updated':
		case 'state.deleted':
		case 'substate.created':
		case 'substate.updated':
		case 'substate.deleted':
			return event.data.project.id === projectId
				? { ...board, project: event.data.project }
				: board;
		case 'project.deleted':
			if (event.data.projectId === projectId) return null;
			return { ...board, tickets: without(event.data.ticketIds) };
		case 'ticket.created':
		case 'ticket.updated':
		case 'ticket.moved':
		case 'ticket.reparented': {
			const { ticket } = event.data;
			const tickets = without([ticket.id]);
			return { ...board, tickets: ticket.projectId === projectId ? [...tickets, ticket] : tickets };
		}
		case 'ticket.ranked': {
			const { id, stateId, rank } = event.data;
			return {
				...board,
				tickets: board.tickets.map((t) => (t.id === id ? { ...t, stateId, rank } : t))
			};
		}
		case 'ticket.rekeyed': {
			const keys = new Map(event.data.tickets.map((t) => [t.id, t.key]));
			return {
				...board,
				tickets: board.tickets.map((t) => ({ ...t, key: keys.get(t.id) ?? t.key }))
			};
		}
		case 'ticket.deleted':
			return { ...board, tickets: without([event.data.id]) };
		default:
			return board;
	}
}

function applyToQuest(quest: Quest, event: Json<WorkloadEvent>): Quest | null {
	const members = (tickets: Member[]): Quest => ({
		...quest,
		tickets,
		progress: { closed: tickets.filter((t) => t.closed).length, total: tickets.length }
	});
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.tickets_added':
		case 'quest.tickets_removed':
		case 'quest.ticket_ranked':
			return event.data.quest.id === quest.id ? event.data.quest : quest;
		case 'quest.deleted':
			return event.data.id === quest.id ? null : quest;
		case 'ticket.updated':
		case 'ticket.moved':
		case 'ticket.reparented': {
			const { ticket } = event.data;
			return members(quest.tickets.map((t) => (t.id === ticket.id ? ticket : t)));
		}
		case 'ticket.ranked': {
			const { id, stateId, rank } = event.data;
			return members(quest.tickets.map((t) => (t.id === id ? { ...t, stateId, rank } : t)));
		}
		case 'ticket.rekeyed': {
			const keys = new Map(event.data.tickets.map((t) => [t.id, t.key]));
			return members(quest.tickets.map((t) => ({ ...t, key: keys.get(t.id) ?? t.key })));
		}
		case 'ticket.deleted':
			return members(quest.tickets.filter((t) => t.id !== event.data.id));
		case 'project.deleted':
			return members(quest.tickets.filter((t) => !event.data.ticketIds.includes(t.id)));
		default:
			return quest;
	}
}

// Board order: by State, then by Rank in code-unit order.
const boardOrder = (board: Board | null): Board | null =>
	board && {
		...board,
		tickets: [...board.tickets].sort((a, b) =>
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
	apply: (view: Json<T>, e: Json<WorkloadEvent>) => Json<T> | null
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
		const project = (key: string) =>
			createProject(db, actor, { name: key, key, initialState: TODO });
		const ticket = (projectId: number, parentId: number | null = null) =>
			createTicket(db, actor, { projectId, title: 't', ownerId: actor.id, parentId });
		const am = project('AM');
		const bl = project('BL');
		const cc = project('CC');
		const quest = createQuest(db, actor, { name: 'Launch', ownerId: actor.id });
		const closedOf = (projectId: number) => listStates(db, projectId).find((s) => s.isClosed)!.id;

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
				'create Tickets across Projects',
				() => {
					a = ticket(am.id).id;
					b = ticket(bl.id, a).id;
					c = ticket(cc.id, a).id;
					d = ticket(am.id).id;
					e = ticket(am.id, d).id;
				}
			],
			['add to the Quest', () => addQuestTicket(db, actor, quest.id, a)],
			['add with Children', () => addQuestTicketWithChildren(db, actor, quest.id, d)],
			['add across Projects', () => addQuestTicket(db, actor, quest.id, c, 'top')],
			['edit a member', () => updateTicket(db, actor, a, { title: 'renamed' })],
			['close a member', () => updateTicket(db, actor, d, { stateId: closedOf(am.id) })],
			['first Substate', () => createSubstate(db, actor, am.initialStateId!, style('review'))],
			['add a State', () => createState(db, actor, am.id, style('doing'))],
			['move a State', () => moveState(db, actor, listStates(db, am.id)[1].id, 0)],
			['restyle a State', () => updateState(db, actor, am.initialStateId!, { label: 'Next' })],
			['rank a member', () => rankTicket(db, actor, e, 'top')],
			['rename a Project key', () => renameProjectKey(db, actor, am.id, 'AX')],
			['move a Parent across Projects', () => moveTicket(db, actor, a, { projectId: bl.id })],
			['move a Child across Projects', () => moveTicket(db, actor, e, { projectId: cc.id })],
			['reparent', () => setParent(db, actor, d, b)],
			['rank in the Quest', () => rankQuestTicket(db, actor, quest.id, a, 'top')],
			['remove from the Quest', () => removeQuestTicket(db, actor, quest.id, e)],
			['delete a Parent and member', () => deleteTicket(db, actor, d)],
			['delete a Project', () => deleteProject(db, actor, bl.id)],
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
		createProject(db, actor, { name: 'AM', key: 'AM', initialState: TODO });
		let inside = false;

		const loaded = readAtSeq(db, () => (inside = db.$client.inTransaction));

		expect(inside).toBe(true);
		expect(loaded.seq).toBe(eventsSince(db, 0).at(-1)!.seq);
	});
});
