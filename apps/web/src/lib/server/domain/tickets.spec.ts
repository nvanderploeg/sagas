import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { ticketKeyAliases, tickets } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket, seedUser } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import { getTicket } from './lookup.ts';
import { createState, createSubstate, listStates } from './states.ts';
import {
	createTicket,
	deleteTicket,
	listTickets,
	moveTicket,
	resolveTicketKey,
	ticketKeyOf,
	updateTicket
} from './tickets.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
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

describe('numbering', () => {
	it('numbers Tickets from the Project counter, separately per Project', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');

		expect(seedTicket(db, { projectId: am.id }).number).toBe(1);
		expect(seedTicket(db, { projectId: am.id }).number).toBe(2);
		expect(seedTicket(db, { projectId: bl.id }).number).toBe(1);
	});

	it('never reuses a number after its Ticket is deleted', () => {
		const project = seedProject(db, 'AM');
		const last = seedTicket(db, { projectId: project.id });

		deleteTicket(db, last.id);

		expect(seedTicket(db, { projectId: project.id }).number).toBe(2);
	});

	it('does not consume a number when creation fails', () => {
		const project = seedProject(db, 'AM');
		const ownerId = seedUser(db, 'ada');
		const ticket = seedTicket(db, { projectId: project.id, ownerId });
		db.insert(ticketKeyAliases).values({ key: 'AM-2', ticketId: ticket.id }).run();

		expectDomainError(
			() => createTicket(db, { projectId: project.id, title: 'x', ownerId }),
			'conflict'
		);
		db.delete(ticketKeyAliases).where(eq(ticketKeyAliases.key, 'AM-2')).run();

		expect(seedTicket(db, { projectId: project.id, ownerId }).number).toBe(2);
	});

	it('gives a Ticket the key of its Project and number', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expect(ticketKeyOf(db, ticket)).toBe('AM-1');
	});
});

describe('resolveTicketKey', () => {
	it('resolves a key in any case', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expect(resolveTicketKey(db, 'am-1')?.id).toBe(ticket.id);
		expect(resolveTicketKey(db, 'Am-1')?.id).toBe(ticket.id);
	});

	it('returns null for an unknown, malformed or zero-numbered key', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });

		expect(resolveTicketKey(db, 'AM-2')).toBeNull();
		expect(resolveTicketKey(db, 'AM-0')).toBeNull();
		expect(resolveTicketKey(db, 'nope')).toBeNull();
	});
});

describe('moveTicket', () => {
	it('gives the Ticket a key from the target Project and keeps the old one as an alias', () => {
		const from = seedProject(db, 'AM');
		const to = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: from.id });
		seedTicket(db, { projectId: to.id });

		const moved = moveTicket(db, ticket.id, to.id);

		expect(moved.projectId).toBe(to.id);
		expect(moved.number).toBe(2);
		expect(ticketKeyOf(db, moved)).toBe('BL-2');
		expect(resolveTicketKey(db, 'AM-1')?.id).toBe(ticket.id);
		expect(resolveTicketKey(db, 'bl-2')?.id).toBe(ticket.id);
	});

	it('moves the Ticket into the target Initial State, with its default Substate', () => {
		const from = seedProject(db, 'AM');
		const to = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: from.id });
		const target = listStates(db, to.id)[0];
		const review = createSubstate(db, target.id, {
			key: 'review',
			label: 'Review',
			color: '#000000',
			icon: 'dot'
		});

		const moved = moveTicket(db, ticket.id, to.id);

		expect(moved.stateId).toBe(target.id);
		expect(moved.substateId).toBe(review.id);
	});

	it('keeps a Ticket resolvable under every key it has held', () => {
		const first = seedProject(db, 'AM');
		const second = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: first.id });

		moveTicket(db, ticket.id, second.id);
		moveTicket(db, ticket.id, first.id);

		expect(resolveTicketKey(db, 'AM-1')?.id).toBe(ticket.id);
		expect(resolveTicketKey(db, 'BL-1')?.id).toBe(ticket.id);
		expect(ticketKeyOf(db, getTicket(db, ticket.id))).toBe('AM-2');
	});

	it('refuses to move into the Project the Ticket is already in', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expectDomainError(() => moveTicket(db, ticket.id, project.id), 'invalid');
	});

	it('keeps the Parent and the Children when moving', () => {
		const from = seedProject(db, 'AM');
		const to = seedProject(db, 'BL');
		const parent = seedTicket(db, { projectId: to.id });
		const child = seedTicket(db, { projectId: from.id, parentId: parent.id });

		moveTicket(db, child.id, to.id);
		const moved = getTicket(db, child.id);

		expect(moved.parentId).toBe(parent.id);
	});
});

describe('Parent', () => {
	it('lets a Ticket sit under a Ticket in any Project', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const parent = seedTicket(db, { projectId: bl.id });

		const child = seedTicket(db, { projectId: am.id, parentId: parent.id });

		expect(child.parentId).toBe(parent.id);
	});

	it('rejects a Ticket as its own Parent', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expectDomainError(() => updateTicket(db, ticket.id, { parentId: ticket.id }), 'invalid');
	});

	it('rejects a Parent that would close a loop of any length', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		const b = seedTicket(db, { projectId: project.id, parentId: a.id });
		const c = seedTicket(db, { projectId: project.id, parentId: b.id });

		expectDomainError(() => updateTicket(db, a.id, { parentId: c.id }), 'conflict');
		expect(getTicket(db, a.id).parentId).toBeNull();
	});

	it('clears the link when the Parent is removed, and clears with null', () => {
		const project = seedProject(db, 'AM');
		const parent = seedTicket(db, { projectId: project.id });
		const child = seedTicket(db, { projectId: project.id, parentId: parent.id });

		deleteTicket(db, parent.id);
		expect(getTicket(db, child.id).parentId).toBeNull();

		const next = seedTicket(db, { projectId: project.id });
		updateTicket(db, child.id, { parentId: next.id });
		expect(updateTicket(db, child.id, { parentId: null }).parentId).toBeNull();
	});
});

describe('updateTicket', () => {
	it('moves to a new State and lands in its default Substate', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const doing = createState(db, project.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		const qa = createSubstate(db, doing.id, {
			key: 'qa',
			label: 'QA',
			color: '#000000',
			icon: 'dot'
		});

		const updated = updateTicket(db, ticket.id, { stateId: doing.id });

		expect(updated.stateId).toBe(doing.id);
		expect(updated.substateId).toBe(qa.id);
	});

	it('moves a Ticket to Closed without a Substate when Closed has none', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		const updated = updateTicket(db, ticket.id, { stateId: closed.id });

		expect(updated).toMatchObject({ stateId: closed.id, substateId: null });
	});

	it('validates the owner and assignee, and allows an empty assignee', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		const other = seedUser(db, 'grace');

		expectDomainError(() => updateTicket(db, ticket.id, { ownerId: 999 }), 'invalid');
		expect(updateTicket(db, ticket.id, { assigneeId: other }).assigneeId).toBe(other);
		expect(updateTicket(db, ticket.id, { assigneeId: null }).assigneeId).toBeNull();
	});

	it('edits the title and description and rejects a blank title', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		const updated = updateTicket(db, ticket.id, { title: ' Fix login ', description: 'Steps...' });

		expect(updated).toMatchObject({ title: 'Fix login', description: 'Steps...' });
		expectDomainError(() => updateTicket(db, ticket.id, { title: '   ' }), 'invalid');
	});

	it('refuses a State of another Project', () => {
		const project = seedProject(db, 'AM');
		const other = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: project.id });
		const foreign = listStates(db, other.id)[0];

		expectDomainError(() => updateTicket(db, ticket.id, { stateId: foreign.id }), 'invalid');
	});
});

describe('createTicket', () => {
	it('lands in the Initial State with its default Substate', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expect(ticket.stateId).toBe(project.initialStateId);
		expect(ticket.substateId).toBeNull();
		expect(ticket.description).toBe('');
	});

	it('rejects an owner that does not exist and a parent that does not exist', () => {
		const project = seedProject(db, 'AM');

		expectDomainError(
			() => createTicket(db, { projectId: project.id, title: 'x', ownerId: 999 }),
			'invalid'
		);
		expectDomainError(() => seedTicket(db, { projectId: project.id, parentId: 999 }), 'not_found');
	});

	it('lists the Tickets of a Project by number', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id, title: 'first' });
		seedTicket(db, { projectId: project.id, title: 'second' });

		expect(listTickets(db, project.id).map((t) => t.title)).toEqual(['first', 'second']);
	});
});

describe('deleteTicket', () => {
	it('removes the Ticket and its aliases', () => {
		const from = seedProject(db, 'AM');
		const to = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: from.id });
		moveTicket(db, ticket.id, to.id);

		deleteTicket(db, ticket.id);

		expect(db.select().from(tickets).where(eq(tickets.id, ticket.id)).all()).toEqual([]);
		expect(resolveTicketKey(db, 'AM-1')).toBeNull();
		expect(db.select().from(ticketKeyAliases).all()).toEqual([]);
	});
});
