import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { questTickets, tickets } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedProject, seedTicket, seedUser } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	addQuestTicket,
	addQuestTicketWithChildren,
	createQuest,
	deleteQuest,
	listQuests,
	listQuestTickets,
	listTicketQuests,
	questProgress,
	rankQuestTicket,
	readQuest,
	removeQuestTicket,
	updateQuest
} from './quests.ts';
import { listStates } from './states.ts';
import { deleteTicket, moveTicket, updateTicket } from './tickets.ts';
import type { Actor } from './write.ts';

let db: Db;
let actor: Actor;
let ownerId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	ownerId = seedUser(db, 'ada');
});

afterEach(() => {
	db.$client.close();
});

function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

const seedQuest = (name = 'Launch') => createQuest(db, actor, { name, ownerId });
const keys = (questId: number) => listQuestTickets(db, questId).map((t) => t.key);
const closedOf = (projectId: number) => listStates(db, projectId).find((s) => s.isClosed)!;

describe('Quest CRUD', () => {
	it('creates a Quest with a name, description and Owner, and no Tickets', () => {
		const quest = createQuest(db, actor, { name: ' Launch ', description: 'Ship it', ownerId });

		expect(quest).toMatchObject({
			name: 'Launch',
			description: 'Ship it',
			ownerId,
			ticketIds: [],
			progress: { closed: 0, total: 0 }
		});
		expect(listQuests(db).map((q) => q.id)).toEqual([quest.id]);
	});

	it('rejects a blank name and an Owner that does not exist', () => {
		expectDomainError(() => createQuest(db, actor, { name: '  ', ownerId }), 'invalid');
		expectDomainError(() => createQuest(db, actor, { name: 'x', ownerId: 999 }), 'invalid');
		expect(listQuests(db)).toEqual([]);
	});

	it('updates the name, description and Owner', () => {
		const quest = seedQuest();
		const grace = seedUser(db, 'grace');

		const updated = updateQuest(db, actor, quest.id, {
			name: 'Relaunch',
			description: 'Again',
			ownerId: grace
		});

		expect(updated).toMatchObject({ name: 'Relaunch', description: 'Again', ownerId: grace });
	});

	it('deletes a Quest and leaves its Tickets in place', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const quest = seedQuest();
		addQuestTicket(db, actor, quest.id, ticket.id);

		deleteQuest(db, actor, quest.id);

		expectDomainError(() => readQuest(db, quest.id), 'not_found');
		expect(db.select().from(questTickets).all()).toEqual([]);
		expect(db.select().from(tickets).all()).toHaveLength(1);
	});
});

describe('membership', () => {
	it('holds Tickets from any Project, in the order they were added', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const a = seedTicket(db, { projectId: am.id });
		const b = seedTicket(db, { projectId: bl.id });
		const quest = seedQuest();

		addQuestTicket(db, actor, quest.id, b.id);
		addQuestTicket(db, actor, quest.id, a.id);

		expect(keys(quest.id)).toEqual(['BL-1', 'AM-1']);
		expect(readQuest(db, quest.id).ticketIds).toEqual([b.id, a.id]);
	});

	it('lets one Ticket sit in any number of Quests', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const first = seedQuest('First');
		const second = seedQuest('Second');

		addQuestTicket(db, actor, first.id, ticket.id);
		addQuestTicket(db, actor, second.id, ticket.id);

		expect(listTicketQuests(db, ticket.id).map((q) => q.name)).toEqual(['First', 'Second']);
	});

	it('never adds a Ticket Children with it', () => {
		const project = seedProject(db, 'AM');
		const parent = seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id, parentId: parent.id });
		const quest = seedQuest();

		addQuestTicket(db, actor, quest.id, parent.id);

		expect(readQuest(db, quest.id).ticketIds).toEqual([parent.id]);
	});

	it('adds the direct Children only through the explicit helper, right after the Ticket', () => {
		const project = seedProject(db, 'AM');
		const first = seedTicket(db, { projectId: project.id });
		const parent = seedTicket(db, { projectId: project.id });
		const child = seedTicket(db, { projectId: project.id, parentId: parent.id });
		const other = seedTicket(db, { projectId: project.id, parentId: parent.id });
		const grandchild = seedTicket(db, { projectId: project.id, parentId: child.id });
		const last = seedTicket(db, { projectId: project.id });
		const quest = seedQuest();
		addQuestTicket(db, actor, quest.id, first.id);
		addQuestTicket(db, actor, quest.id, last.id);
		addQuestTicket(db, actor, quest.id, other.id);

		const view = addQuestTicketWithChildren(db, actor, quest.id, parent.id, {
			after: first.id
		});

		expect(view.ticketIds).toEqual([first.id, parent.id, child.id, last.id, other.id]);
		expect(view.ticketIds).not.toContain(grandchild.id);
		expectDomainError(() => addQuestTicketWithChildren(db, actor, quest.id, parent.id), 'conflict');
	});

	it('refuses a Ticket already in the Quest, and removing one that is not', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const quest = seedQuest();
		addQuestTicket(db, actor, quest.id, ticket.id);

		expectDomainError(() => addQuestTicket(db, actor, quest.id, ticket.id), 'conflict');
		removeQuestTicket(db, actor, quest.id, ticket.id);
		expectDomainError(() => removeQuestTicket(db, actor, quest.id, ticket.id), 'not_found');
		expect(readQuest(db, quest.id).ticketIds).toEqual([]);
	});

	it('refuses an unknown Ticket or Quest', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const quest = seedQuest();

		expectDomainError(() => addQuestTicket(db, actor, quest.id, 999), 'not_found');
		expectDomainError(() => addQuestTicket(db, actor, 999, ticket.id), 'not_found');
	});

	it('drops a deleted Ticket from every Quest it was in', () => {
		const project = seedProject(db, 'AM');
		const gone = seedTicket(db, { projectId: project.id });
		const kept = seedTicket(db, { projectId: project.id });
		const first = seedQuest('First');
		const second = seedQuest('Second');
		for (const quest of [first, second]) {
			addQuestTicket(db, actor, quest.id, gone.id);
			addQuestTicket(db, actor, quest.id, kept.id);
		}

		deleteTicket(db, actor, gone.id);

		expect(readQuest(db, first.id).ticketIds).toEqual([kept.id]);
		expect(readQuest(db, second.id).ticketIds).toEqual([kept.id]);
	});
});

describe('Quest order', () => {
	it('places a Ticket at a position when added, and reorders within the Quest', () => {
		const project = seedProject(db, 'AM');
		const [a, b, c] = [1, 2, 3].map(() => seedTicket(db, { projectId: project.id }));
		const quest = seedQuest();
		addQuestTicket(db, actor, quest.id, a.id);
		addQuestTicket(db, actor, quest.id, b.id);
		addQuestTicket(db, actor, quest.id, c.id, 'top');
		expect(keys(quest.id)).toEqual(['AM-3', 'AM-1', 'AM-2']);

		rankQuestTicket(db, actor, quest.id, c.id, { after: a.id });
		expect(keys(quest.id)).toEqual(['AM-1', 'AM-3', 'AM-2']);

		rankQuestTicket(db, actor, quest.id, a.id, 'bottom');
		expect(keys(quest.id)).toEqual(['AM-3', 'AM-2', 'AM-1']);

		rankQuestTicket(db, actor, quest.id, a.id, { before: c.id });
		expect(keys(quest.id)).toEqual(['AM-1', 'AM-3', 'AM-2']);
	});

	it('keeps its own order, independent of the board', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		const b = seedTicket(db, { projectId: project.id });
		const quest = seedQuest();
		addQuestTicket(db, actor, quest.id, b.id);
		addQuestTicket(db, actor, quest.id, a.id);

		updateTicket(db, actor, b.id, { placement: 'bottom' });

		expect(readQuest(db, quest.id).ticketIds).toEqual([b.id, a.id]);
	});

	it('refuses to rank against a Ticket outside the Quest, or a Ticket not in it', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		const outside = seedTicket(db, { projectId: project.id });
		const quest = seedQuest();
		addQuestTicket(db, actor, quest.id, a.id);

		expectDomainError(
			() => addQuestTicket(db, actor, quest.id, outside.id, { before: 999 }),
			'invalid'
		);
		expectDomainError(
			() => rankQuestTicket(db, actor, quest.id, a.id, { after: outside.id }),
			'invalid'
		);
		expectDomainError(() => rankQuestTicket(db, actor, quest.id, outside.id, 'top'), 'not_found');
	});
});

describe('progress', () => {
	it('is the Closed Tickets over all Tickets, across Projects', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const a = seedTicket(db, { projectId: am.id });
		const b = seedTicket(db, { projectId: bl.id });
		const c = seedTicket(db, { projectId: bl.id });
		const quest = seedQuest();
		for (const ticket of [a, b, c]) addQuestTicket(db, actor, quest.id, ticket.id);

		expect(questProgress(db, quest.id)).toEqual({ closed: 0, total: 3 });

		updateTicket(db, actor, a.id, { stateId: closedOf(am.id).id });
		updateTicket(db, actor, b.id, { stateId: closedOf(bl.id).id });
		expect(questProgress(db, quest.id)).toEqual({ closed: 2, total: 3 });

		moveTicket(db, actor, a.id, { projectId: bl.id });
		expect(readQuest(db, quest.id).progress).toEqual({ closed: 2, total: 3 });

		deleteTicket(db, actor, c.id);
		expect(readQuest(db, quest.id).progress).toEqual({ closed: 2, total: 2 });
	});

	it('is zero over zero for an empty Quest', () => {
		expect(questProgress(db, seedQuest().id)).toEqual({ closed: 0, total: 0 });
	});
});
