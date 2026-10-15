import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import type { Actor } from './write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedProject, seedTicket, TODO } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import { getProject } from './lookup.ts';
import { eventsSince } from '../events/log.ts';
import {
	createProject,
	createProjectWithStates,
	deleteProject,
	listProjects,
	renameProjectKey,
	setInitialState,
	updateProject
} from './projects.ts';
import { createState, listStates } from './states.ts';
import { moveTicket, resolveTicketKey, ticketKeyOf } from './tickets.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
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
				createProject(db, actor, {
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
			() => createProject(db, actor, { name: '  ', key: 'AM', initialState: TODO }),
			'invalid'
		);
	});
});

describe('createProjectWithStates', () => {
	const DOING = { key: 'doing', label: 'Doing', color: '#eab308', icon: 'half' };
	const REVIEW = { key: 'review', label: 'Review', color: '#a855f7', icon: 'eye' };

	it('creates the Project and its open States in one write with one Event', () => {
		const project = createProjectWithStates(db, actor, {
			name: 'Atlas',
			key: 'AM',
			initialState: TODO,
			states: [DOING, REVIEW]
		});

		expect(listStates(db, project.id).map((s) => s.key)).toEqual([
			'todo',
			'doing',
			'review',
			'closed'
		]);
		expect(project.initialStateId).toBe(listStates(db, project.id)[0].id);
		const events = eventsSince(db, 0);
		expect(events.map((e) => e.type)).toEqual(['project.created']);
		const created = events[0].data as { project: { states: { key: string }[] } };
		expect(created.project.states.map((s) => s.key)).toEqual(['todo', 'doing', 'review', 'closed']);
	});

	it('creates nothing when one of the States is refused', () => {
		expectDomainError(
			() =>
				createProjectWithStates(db, actor, {
					name: 'Atlas',
					key: 'AM',
					initialState: TODO,
					states: [DOING, { ...REVIEW, color: 'purple' }]
				}),
			'invalid'
		);
		expect(listProjects(db)).toEqual([]);
		expect(eventsSince(db, 0)).toEqual([]);
	});
});

describe('setInitialState', () => {
	it('picks an open State of the same Project', () => {
		const project = seedProject(db, 'AM');
		const doing = createState(db, actor, project.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});

		expect(setInitialState(db, actor, project.id, doing.id).initialStateId).toBe(doing.id);
	});

	it('rejects the Closed State', () => {
		const project = seedProject(db, 'AM');
		const closed = listStates(db, project.id).find((s) => s.isClosed)!;

		expectDomainError(() => setInitialState(db, actor, project.id, closed.id), 'invalid');
	});

	it('rejects a State of another Project', () => {
		const first = seedProject(db, 'AM');
		const second = seedProject(db, 'BL');
		const foreign = listStates(db, second.id)[0];

		expectDomainError(() => setInitialState(db, actor, first.id, foreign.id), 'invalid');
	});
});

describe('updateProject', () => {
	it('renames the Project without touching its key', () => {
		const project = seedProject(db, 'AM');

		const updated = updateProject(db, actor, project.id, { name: 'Amber' });

		expect(updated.name).toBe('Amber');
		expect(updated.key).toBe('AM');
	});
});

describe('renameProjectKey', () => {
	it('keeps the old key resolving to every Ticket of the Project', () => {
		const project = seedProject(db, 'AM');
		const first = seedTicket(db, { projectId: project.id });
		const second = seedTicket(db, { projectId: project.id });

		renameProjectKey(db, actor, project.id, 'BL');

		expect(resolveTicketKey(db, 'am-1')?.id).toBe(first.id);
		expect(resolveTicketKey(db, 'AM-2')?.id).toBe(second.id);
		expect(resolveTicketKey(db, 'BL-2')?.id).toBe(second.id);
	});

	it('reserves the current and former keys of a Project while it exists', () => {
		const project = seedProject(db, 'AM');
		renameProjectKey(db, actor, project.id, 'BL');
		const other = seedProject(db, 'CX');

		expectDomainError(() => seedProject(db, 'AM'), 'conflict');
		expectDomainError(() => seedProject(db, 'bl'), 'conflict');
		expectDomainError(() => renameProjectKey(db, actor, other.id, 'AM'), 'conflict');
		expect(getProject(db, other.id).key).toBe('CX');
	});

	it('lets a Project take back a key it used to hold', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		renameProjectKey(db, actor, project.id, 'BL');

		expect(renameProjectKey(db, actor, project.id, 'am').key).toBe('AM');
		expect(resolveTicketKey(db, 'BL-1')?.projectId).toBe(project.id);
	});

	it('lets a Project take back its own former key after one of its Tickets moved out', () => {
		const project = seedProject(db, 'AM');
		const other = seedProject(db, 'XY');
		const leaving = seedTicket(db, { projectId: project.id });
		const staying = seedTicket(db, { projectId: project.id });
		moveTicket(db, actor, leaving.id, { projectId: other.id });
		renameProjectKey(db, actor, project.id, 'BM');

		expect(renameProjectKey(db, actor, project.id, 'AM').key).toBe('AM');
		expect(resolveTicketKey(db, 'AM-1')?.id).toBe(leaving.id);
		expect(resolveTicketKey(db, 'AM-2')?.id).toBe(staying.id);
	});

	it('releases the keys of a deleted Project, while its moved Tickets keep answering to them', () => {
		const old = seedProject(db, 'AM');
		const other = seedProject(db, 'BL');
		const ticket = seedTicket(db, { projectId: old.id });
		moveTicket(db, actor, ticket.id, { projectId: other.id });
		deleteProject(db, actor, old.id);

		const reborn = seedProject(db, 'AM');

		expect(ticketKeyOf(db, seedTicket(db, { projectId: reborn.id }))).toBe('AM-2');
		expect(resolveTicketKey(db, 'AM-1')?.id).toBe(ticket.id);
	});

	it('rejects a key already held by another Project', () => {
		seedProject(db, 'AM');
		const other = seedProject(db, 'BL');

		expectDomainError(() => renameProjectKey(db, actor, other.id, 'AM'), 'conflict');
	});

	it('rejects an invalid key and leaves the Project unchanged', () => {
		const project = seedProject(db, 'AM');

		expectDomainError(() => renameProjectKey(db, actor, project.id, 'X'), 'invalid');
		expect(getProject(db, project.id).key).toBe('AM');
	});
});

describe('deleteProject', () => {
	it('removes the Project with its States, Tickets and keys', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		renameProjectKey(db, actor, project.id, 'BL');

		deleteProject(db, actor, project.id);

		expect(listProjects(db)).toEqual([]);
		expect(resolveTicketKey(db, 'BL-1')).toBeNull();
		expect(resolveTicketKey(db, 'AM-1')).toBeNull();
	});

	it('reports a missing Project as not found', () => {
		expectDomainError(() => deleteProject(db, actor, 999), 'not_found');
	});
});
