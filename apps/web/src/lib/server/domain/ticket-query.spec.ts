import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedProject, seedTicket, seedUser } from '#lib/server/test/fixtures.ts';
import { addQuestTicket, createQuest } from './quests.ts';
import { createState, listStates, moveState } from './states.ts';
import { queryTickets, type TicketFilter } from './ticket-query.ts';
import { rankTicket, setParent, updateTicket } from './tickets.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

const all = { offset: 0, limit: 100 };
const keys = (filter: TicketFilter, page = all) =>
	queryTickets(db, filter, page).tickets.map((t) => t.key);

describe('queryTickets', () => {
	it('orders by Project, then State position, then Rank', () => {
		const am = seedProject(db, 'AM');
		const ops = seedProject(db, 'OPS');
		const actor = seedActor(db);
		const [todo, closed] = listStates(db, am.id);
		const doing = createState(db, actor, am.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		moveState(db, actor, doing.id, 0);
		const done = seedTicket(db, { projectId: am.id });
		seedTicket(db, { projectId: am.id });
		seedTicket(db, { projectId: ops.id });
		const t3 = seedTicket(db, { projectId: am.id });
		const t4 = seedTicket(db, { projectId: am.id });
		updateTicket(db, actor, done.id, { stateId: closed.id });
		updateTicket(db, actor, t4.id, { stateId: doing.id });
		rankTicket(db, actor, t3.id, 'top');

		const byPosition = listStates(db, am.id).map((s) => s.id);
		expect(byPosition).toEqual([doing.id, todo.id, closed.id]);
		expect(byPosition.toSorted((a, b) => a - b)).not.toEqual(byPosition);
		expect(keys({})).toEqual(['AM-4', 'AM-3', 'AM-2', 'AM-1', 'OPS-1']);
	});

	it('filters by State, owner, assignee, Parent and closed', () => {
		const am = seedProject(db, 'AM');
		const actor = seedActor(db);
		const ada = seedUser(db, 'ada');
		const closed = listStates(db, am.id).find((s) => s.isClosed)!;
		const parent = seedTicket(db, { projectId: am.id, ownerId: ada });
		const child = seedTicket(db, { projectId: am.id, assigneeId: ada });
		setParent(db, actor, child.id, parent.id);
		updateTicket(db, actor, parent.id, { stateId: closed.id });

		expect(keys({ ownerId: ada })).toEqual(['AM-1']);
		expect(keys({ assigneeId: ada })).toEqual(['AM-2']);
		expect(keys({ assigneeId: null })).toEqual(['AM-1']);
		expect(keys({ parentId: parent.id })).toEqual(['AM-2']);
		expect(keys({ parentId: null })).toEqual(['AM-1']);
		expect(keys({ closed: true })).toEqual(['AM-1']);
		expect(keys({ closed: false, projectId: am.id })).toEqual(['AM-2']);
		expect(keys({ stateId: closed.id })).toEqual(['AM-1']);
	});

	it('lists a Quest in Quest order', () => {
		const am = seedProject(db, 'AM');
		const actor = seedActor(db);
		const quest = createQuest(db, actor, { name: 'Q', ownerId: seedUser(db) });
		const [a, b] = [seedTicket(db, { projectId: am.id }), seedTicket(db, { projectId: am.id })];
		seedTicket(db, { projectId: am.id });
		addQuestTicket(db, actor, quest.id, a.id);
		addQuestTicket(db, actor, quest.id, b.id, 'top');

		expect(keys({ questId: quest.id })).toEqual(['AM-2', 'AM-1']);
		expect(queryTickets(db, { questId: quest.id }, all).total).toBe(2);
	});

	it('pages in Rank order with offset and limit, and counts every match', () => {
		const am = seedProject(db, 'AM');
		const actor = seedActor(db);
		const made = [1, 2, 3, 4, 5].map(() => seedTicket(db, { projectId: am.id }));
		rankTicket(db, actor, made[4].id, 'top');
		rankTicket(db, actor, made[3].id, 'top');

		expect(keys({ projectId: am.id })).toEqual(['AM-4', 'AM-5', 'AM-1', 'AM-2', 'AM-3']);
		const page = queryTickets(db, { projectId: am.id }, { offset: 2, limit: 2 });

		expect(page.tickets.map((t) => t.key)).toEqual(['AM-1', 'AM-2']);
		expect(page.total).toBe(5);
	});
});
