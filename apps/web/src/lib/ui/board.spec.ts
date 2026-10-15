import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { readBoard } from '#lib/server/domain/projects.ts';
import { rankTicket, updateTicket } from '#lib/server/domain/tickets.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedProject, seedTicket } from '#lib/server/test/fixtures.ts';
import { toJson } from '#lib/server/ui/reads.ts';
import { byRank } from '../live/apply.ts';
import type { BoardView, Ticket } from '../live/types.ts';
import { Drafts, matches, moveOnBoard, placementAt, type Placement } from './board.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const order = (board: BoardView, stateId: number) =>
	board.tickets
		.filter((t) => t.stateId === stateId)
		.sort(byRank)
		.map((t) => t.id);

describe('moveOnBoard', () => {
	it('predicts the Rank and State the server records', () => {
		const project = seedProject(db);
		const ids = Array.from(
			{ length: 5 },
			() => seedTicket(db, { projectId: project.id, ownerId: actor.id }).id
		);
		const board = () => toJson(readBoard(db, project.id)) as BoardView;
		const open = project.initialStateId!;
		const closed = board().project.states.find((s) => s.isClosed)!.id;

		const moves: [number, number, Placement][] = [
			[ids[4], open, 'top'],
			[ids[0], open, { after: ids[2] }],
			[ids[1], closed, 'top'],
			[ids[3], closed, { after: ids[1] }],
			[ids[2], open, 'bottom'],
			[ids[1], open, { before: ids[4] }]
		];
		for (const [id, stateId, placement] of moves) {
			const before = board();
			const predicted = moveOnBoard(before, id, stateId, placement)!;
			const current = before.tickets.find((t) => t.id === id)!;
			if (current.stateId === stateId) rankTicket(db, actor, id, placement);
			else updateTicket(db, actor, id, { stateId, placement });
			const after = board();
			const pick = (b: BoardView) => b.tickets.find((t) => t.id === id)!;
			expect(pick(predicted)).toMatchObject({
				stateId,
				rank: pick(after).rank,
				closed: pick(after).closed,
				substateId: pick(after).substateId
			});
			expect(order(predicted, stateId)).toEqual(order(after, stateId));
		}
	});

	it('is null for a drop back where the card was', () => {
		const project = seedProject(db);
		const a = seedTicket(db, { projectId: project.id });
		const b = seedTicket(db, { projectId: project.id });
		const board = toJson(readBoard(db, project.id)) as BoardView;
		expect(moveOnBoard(board, b.id, b.stateId, { after: a.id })).toBeNull();
	});
});

describe('placementAt', () => {
	const t = (id: number) => ({ id }) as Ticket;
	it('places at the top, or after the card above the drop', () => {
		expect(placementAt([], 0)).toBe('top');
		expect(placementAt([t(4), t(7)], 0)).toBe('top');
		expect(placementAt([t(4), t(7)], 1)).toEqual({ after: 4 });
		expect(placementAt([t(4), t(7)], 2)).toEqual({ after: 7 });
	});
});

describe('Drafts', () => {
	it('shows a draft card until its Ticket arrives, and never both', () => {
		const project = seedProject(db);
		seedTicket(db, { projectId: project.id, title: 'Existing' });
		const loaded = toJson(readBoard(db, project.id)) as BoardView;
		const card = { ...loaded.tickets[0], id: -1, title: 'Fresh', key: '' };
		const drafts = new Drafts();
		const patch = drafts.add(card, new Set(loaded.tickets.map((t) => t.id)));

		expect(patch(loaded).tickets.map((t) => t.title)).toEqual(['Existing', 'Fresh']);

		const created = seedTicket(db, { projectId: project.id, title: 'Fresh' });
		const arrived = toJson(readBoard(db, project.id)) as BoardView;
		expect(patch(arrived).tickets.map((t) => t.id)).toEqual(arrived.tickets.map((t) => t.id));
		drafts.answer(-1, created.id);
		expect(patch(arrived).tickets.map((t) => t.id)).toEqual(arrived.tickets.map((t) => t.id));
	});

	it('gives way only to the Ticket its create answered with, once it has answered', () => {
		const project = seedProject(db);
		const stateId = project.initialStateId!;
		const drafts = new Drafts();
		const patch = drafts.add({ ...({} as Ticket), id: -1, stateId, title: 'Mine' }, new Set());
		drafts.answer(-1, 999);

		const other = seedTicket(db, { projectId: project.id, title: 'Mine' });
		const board = toJson(readBoard(db, project.id)) as BoardView;
		expect(patch(board).tickets.map((t) => t.id)).toEqual([other.id, -1]);
	});

	it('gives each of two drafts with the same title a Ticket of its own', () => {
		const project = seedProject(db);
		const loaded = toJson(readBoard(db, project.id)) as BoardView;
		const stateId = project.initialStateId!;
		const base = { ...({} as Ticket), stateId, title: 'Same', key: '', rank: '' };
		const drafts = new Drafts();
		const patches = [-1, -2].map((id) => drafts.add({ ...base, id }, new Set()));
		const shown = (board: BoardView) =>
			patches.reduce((view, patch) => patch(view), board).tickets.map((t) => t.id);

		expect(shown(loaded)).toEqual([-1, -2]);
		const first = seedTicket(db, { projectId: project.id, title: 'Same' });
		const one = toJson(readBoard(db, project.id)) as BoardView;
		expect(shown(one)).toEqual([first.id, -2]);

		drafts.answer(-2, first.id);
		expect(shown(one)).toEqual([first.id, -1]);
		const second = seedTicket(db, { projectId: project.id, title: 'Same' });
		drafts.answer(-1, second.id);
		const both = toJson(readBoard(db, project.id)) as BoardView;
		expect(shown(both)).toEqual([first.id, second.id]);
	});
});

describe('matches', () => {
	const ticket = { ownerId: 1, assigneeId: 2 } as Ticket;
	it('filters by owner and by assignee', () => {
		expect(matches(ticket, { owner: null, assignee: null })).toBe(true);
		expect(matches(ticket, { owner: 1, assignee: 2 })).toBe(true);
		expect(matches(ticket, { owner: 3, assignee: null })).toBe(false);
		expect(matches(ticket, { owner: null, assignee: 'none' })).toBe(false);
		expect(matches({ ...ticket, assigneeId: null }, { owner: null, assignee: 'none' })).toBe(true);
	});
});
