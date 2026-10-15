import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket, seedUser } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	listStates,
	listSubstates,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	updateState,
	updateSubstate
} from './states.ts';
import { getState } from './lookup.ts';
import { createTicket, updateTicket } from './tickets.ts';

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

const spec = (key: string) => ({ key, label: key, color: '#abcdef', icon: 'dot' });

const order = (projectId: number) => listStates(db, projectId).map((s) => s.key);

describe('State order', () => {
	it('places a new State before Closed, and Closed stays last', () => {
		const project = seedProject(db, 'AM');

		createState(db, project.id, spec('doing'));
		createState(db, project.id, spec('review'));

		expect(order(project.id)).toEqual(['todo', 'doing', 'review', 'closed']);
	});

	it('inserts a State at the given index among the open States', () => {
		const project = seedProject(db, 'AM');

		createState(db, project.id, spec('doing'), 0);

		expect(order(project.id)).toEqual(['doing', 'todo', 'closed']);
	});

	it('rejects an index past the open States, which would land after Closed', () => {
		const project = seedProject(db, 'AM');

		expectDomainError(() => createState(db, project.id, spec('doing'), 2), 'invalid');
		expect(order(project.id)).toEqual(['todo', 'closed']);
	});

	it('rejects a key already used in the Project, and the built-in Closed key', () => {
		const project = seedProject(db, 'AM');

		expectDomainError(() => createState(db, project.id, spec('todo')), 'conflict');
		expectDomainError(() => createState(db, project.id, spec('closed')), 'conflict');
	});

	it('rejects a malformed key, color or icon', () => {
		const project = seedProject(db, 'AM');

		expectDomainError(() => createState(db, project.id, { ...spec('Doing') }), 'invalid');
		expectDomainError(
			() => createState(db, project.id, { ...spec('doing'), color: 'red' }),
			'invalid'
		);
		expectDomainError(
			() => createState(db, project.id, { ...spec('doing'), icon: 'Dot Icon' }),
			'invalid'
		);
	});

	it('moves an open State to another open position', () => {
		const project = seedProject(db, 'AM');
		createState(db, project.id, spec('doing'));
		createState(db, project.id, spec('review'));

		moveState(db, listStates(db, project.id).find((s) => s.key === 'review')!.id, 0);

		expect(order(project.id)).toEqual(['review', 'todo', 'doing', 'closed']);
	});

	it('refuses to move Closed', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		expectDomainError(() => moveState(db, closed.id, 0), 'forbidden');
	});

	it('refuses to move an open State past Closed', () => {
		const project = seedProject(db, 'AM');
		const todo = listStates(db, project.id)[0];

		expectDomainError(() => moveState(db, todo.id, 1), 'invalid');
		expect(order(project.id)).toEqual(['todo', 'closed']);
	});
});

describe('updateState', () => {
	it('renames an open State and recolors it', () => {
		const project = seedProject(db, 'AM');
		const todo = listStates(db, project.id)[0];

		const updated = updateState(db, todo.id, { label: 'Backlog', color: '#010203' });

		expect(updated).toMatchObject({ label: 'Backlog', color: '#010203', key: 'todo' });
	});

	it('refuses to rename Closed', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		expectDomainError(() => updateState(db, closed.id, { label: 'Done' }), 'forbidden');
		expect(getState(db, closed.id).label).toBe('Closed');
	});

	it('still recolors and re-icons Closed', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		const updated = updateState(db, closed.id, { label: 'Closed', color: '#123456', icon: 'flag' });

		expect(updated).toMatchObject({ color: '#123456', icon: 'flag', label: 'Closed' });
	});
});

describe('deleteState', () => {
	it('removes an open State and closes the gap in positions', () => {
		const project = seedProject(db, 'AM');
		const doing = createState(db, project.id, spec('doing'));
		createState(db, project.id, spec('review'));

		deleteState(db, doing.id);

		expect(order(project.id)).toEqual(['todo', 'review', 'closed']);
		expect(listStates(db, project.id).map((s) => s.position)).toEqual([0, 1, 2]);
	});

	it('refuses to remove Closed', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		expectDomainError(() => deleteState(db, closed.id), 'forbidden');
	});

	it('refuses to remove the Initial State', () => {
		const project = seedProject(db, 'AM');
		const todo = listStates(db, project.id)[0];

		expectDomainError(() => deleteState(db, todo.id), 'conflict');
	});

	it('refuses to remove a State that still holds Tickets', () => {
		const project = seedProject(db, 'AM');
		const doing = createState(db, project.id, spec('doing'));
		seedTicket(db, { projectId: project.id, stateId: doing.id });

		expectDomainError(() => deleteState(db, doing.id), 'conflict');
	});
});

describe('Substates', () => {
	const todoId = (projectId: number) => listStates(db, projectId)[0].id;

	it('makes the first Substate the default and moves existing Tickets into it', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });
		expect(ticket.substateId).toBeNull();

		const review = createSubstate(db, todoId(project.id), spec('review'));

		expect(getState(db, todoId(project.id)).defaultSubstateId).toBe(review.id);
		expect(
			db.$client.prepare('SELECT substate_id FROM tickets WHERE id = ?').pluck().get(ticket.id)
		).toBe(review.id);
	});

	it('lands a Ticket without a Substate in the State default, and rejects a Substate of another State', () => {
		const project = seedProject(db, 'AM');
		const first = createSubstate(db, todoId(project.id), spec('review'));
		const doing = createState(db, project.id, spec('doing'));
		const other = createSubstate(db, doing.id, spec('qa'));

		const ticket = seedTicket(db, { projectId: project.id });
		expect(ticket.substateId).toBe(first.id);

		expectDomainError(() => updateTicket(db, ticket.id, { substateId: other.id }), 'invalid');
	});

	it('rejects a Substate on a State that has none, and a Substate of another State on create', () => {
		const project = seedProject(db, 'AM');
		const doing = createState(db, project.id, spec('doing'));
		const qa = createSubstate(db, doing.id, spec('qa'));
		const ownerId = seedUser(db, 'owner');

		expectDomainError(
			() => createTicket(db, { projectId: project.id, title: 'x', ownerId, substateId: qa.id }),
			'invalid'
		);
	});

	it('keeps the default when another Substate is added, and reorders Substates', () => {
		const project = seedProject(db, 'AM');
		const review = createSubstate(db, todoId(project.id), spec('review'));
		const qa = createSubstate(db, todoId(project.id), spec('qa'));

		expect(getState(db, todoId(project.id)).defaultSubstateId).toBe(review.id);
		moveSubstate(db, qa.id, 0);
		expect(listSubstates(db, todoId(project.id)).map((s) => s.key)).toEqual(['qa', 'review']);
	});

	it('updates a Substate label without changing its key', () => {
		const project = seedProject(db, 'AM');
		const review = createSubstate(db, todoId(project.id), spec('review'));

		expect(updateSubstate(db, review.id, { label: 'Code review' })).toMatchObject({
			key: 'review',
			label: 'Code review'
		});
	});

	it('sets the default only to one of the State own Substates', () => {
		const project = seedProject(db, 'AM');
		const review = createSubstate(db, todoId(project.id), spec('review'));
		const doing = createState(db, project.id, spec('doing'));
		const qa = createSubstate(db, doing.id, spec('qa'));

		expectDomainError(() => setDefaultSubstate(db, todoId(project.id), qa.id), 'invalid');
		expect(setDefaultSubstate(db, todoId(project.id), review.id).defaultSubstateId).toBe(review.id);
	});

	it('refuses to remove the default Substate while others remain', () => {
		const project = seedProject(db, 'AM');
		const review = createSubstate(db, todoId(project.id), spec('review'));
		createSubstate(db, todoId(project.id), spec('qa'));

		expectDomainError(() => deleteSubstate(db, review.id), 'conflict');
	});

	it('refuses to remove a Substate that still holds Tickets', () => {
		const project = seedProject(db, 'AM');
		const qa = createSubstate(db, todoId(project.id), spec('review'));
		const extra = createSubstate(db, todoId(project.id), spec('qa'));
		seedTicket(db, { projectId: project.id });
		setDefaultSubstate(db, todoId(project.id), extra.id);

		expectDomainError(() => deleteSubstate(db, qa.id), 'conflict');
	});

	it('clears the default when the last Substate is removed', () => {
		const project = seedProject(db, 'AM');
		const review = createSubstate(db, todoId(project.id), spec('review'));

		deleteSubstate(db, review.id);

		expect(getState(db, todoId(project.id)).defaultSubstateId).toBeNull();
		expect(listSubstates(db, todoId(project.id))).toEqual([]);
	});

	it('lets Closed hold Substates', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		const done = createSubstate(db, closed.id, spec('shipped'));

		expect(getState(db, closed.id).defaultSubstateId).toBe(done.id);
	});
});
