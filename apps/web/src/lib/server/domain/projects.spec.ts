import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket, TODO } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import { getProject } from './lookup.ts';
import {
	createProject,
	deleteProject,
	listProjects,
	renameProjectKey,
	setInitialState,
	updateProject
} from './projects.ts';
import { createState, listStates } from './states.ts';
import { moveTicket, resolveTicketKey } from './tickets.ts';

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

describe('createProject', () => {
	it('creates the built-in Closed State last, with the Initial State before it', () => {
		const project = seedProject(db, 'AM');

		expect(listStates(db, project.id).map((s) => [s.key, s.isClosed])).toEqual([
			['todo', false],
			['closed', true]
		]);
		expect(project.initialStateId).toBe(listStates(db, project.id)[0].id);
	});

	it('stores the key uppercase', () => {
		seedProject(db, 'am');

		expect(listProjects(db).map((p) => p.key)).toEqual(['AM']);
	});

	it('rejects an invalid key without creating anything', () => {
		expectDomainError(() => seedProject(db, 'A'), 'invalid');
		expect(listProjects(db)).toEqual([]);
	});

	it('rejects a key already used, ignoring case', () => {
		seedProject(db, 'AM');

		expectDomainError(() => seedProject(db, 'am'), 'conflict');
	});

	it('rejects a Closed Initial State and creates nothing', () => {
		expectDomainError(
			() =>
				createProject(db, {
					name: 'Closed Initial',
					key: 'CI',
					initialState: { ...TODO, key: 'closed' }
				}),
			'conflict'
		);
		expect(listProjects(db)).toEqual([]);
	});

	it('rejects a blank name', () => {
		expectDomainError(
			() => createProject(db, { name: '  ', key: 'AM', initialState: TODO }),
			'invalid'
		);
	});
});

describe('setInitialState', () => {
	it('picks an open State of the same Project', () => {
		const project = seedProject(db, 'AM');
		const doing = createState(db, project.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});

		expect(setInitialState(db, project.id, doing.id).initialStateId).toBe(doing.id);
	});

	it('rejects the Closed State', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		expectDomainError(() => setInitialState(db, project.id, closed.id), 'invalid');
	});

	it('rejects a State of another Project', () => {
		const first = seedProject(db, 'AM');
		const second = seedProject(db, 'BL');
		const foreign = listStates(db, second.id)[0];

		expectDomainError(() => setInitialState(db, first.id, foreign.id), 'invalid');
	});
});

describe('updateProject', () => {
	it('renames the Project without touching its key', () => {
		const project = seedProject(db, 'AM');

		const updated = updateProject(db, project.id, { name: 'Amber' });

		expect(updated.name).toBe('Amber');
		expect(updated.key).toBe('AM');
	});
});

describe('renameProjectKey', () => {
	it('keeps the old key resolving to every Ticket of the Project', () => {
		const project = seedProject(db, 'AM');
		const first = seedTicket(db, { projectId: project.id });
		const second = seedTicket(db, { projectId: project.id });

		renameProjectKey(db, project.id, 'BL');

		expect(resolveTicketKey(db, 'am-1')?.id).toBe(first.id);
		expect(resolveTicketKey(db, 'AM-2')?.id).toBe(second.id);
		expect(resolveTicketKey(db, 'BL-2')?.id).toBe(second.id);
	});

	it('keeps the old key reserved against new Projects', () => {
		const project = seedProject(db, 'AM');
		renameProjectKey(db, project.id, 'BL');

		expectDomainError(() => seedProject(db, 'AM'), 'conflict');
	});

	it('lets a Project take back a key it used to hold', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		renameProjectKey(db, project.id, 'BL');

		expect(renameProjectKey(db, project.id, 'am').key).toBe('AM');
		expect(resolveTicketKey(db, 'BL-1')?.projectId).toBe(project.id);
	});

	it('rejects a key that a Ticket of another Project still answers to', () => {
		const old = seedProject(db, 'AM');
		const other = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: old.id });
		moveTicket(db, ticket.id, other.id);
		expect(resolveTicketKey(db, 'AM-1')?.projectId).toBe(other.id);
		deleteProject(db, old.id);

		expectDomainError(() => seedProject(db, 'AM'), 'conflict');
	});

	it('rejects a key already held by another Project', () => {
		seedProject(db, 'AM');
		const other = seedProject(db, 'BL');

		expectDomainError(() => renameProjectKey(db, other.id, 'AM'), 'conflict');
	});

	it('rejects an invalid key and leaves the Project unchanged', () => {
		const project = seedProject(db, 'AM');

		expectDomainError(() => renameProjectKey(db, project.id, 'X'), 'invalid');
		expect(getProject(db, project.id).key).toBe('AM');
	});
});

describe('deleteProject', () => {
	it('removes the Project with its States, Tickets and aliases', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		renameProjectKey(db, project.id, 'BL');

		deleteProject(db, project.id);

		expect(listProjects(db)).toEqual([]);
		expect(resolveTicketKey(db, 'BL-1')).toBeNull();
		expect(resolveTicketKey(db, 'AM-1')).toBeNull();
	});

	it('reports a missing Project as not found', () => {
		expectDomainError(() => deleteProject(db, 999), 'not_found');
	});
});
