import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { renameProjectKey } from '#lib/server/domain/projects.ts';
import { createQuest } from '#lib/server/domain/quests.ts';
import { createSubstate, listStates } from '#lib/server/domain/states.ts';
import { moveTicket } from '#lib/server/domain/tickets.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedProject, seedTicket, seedUser } from '#lib/server/test/fixtures.ts';
import * as refs from './refs.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

function failure(action: () => unknown): DomainError {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

describe('ticketId', () => {
	it('resolves a key in any case, and an id as a number or digit string', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expect(refs.ticketId(db, 'AM-1')).toBe(ticket.id);
		expect(refs.ticketId(db, ' am-1 ')).toBe(ticket.id);
		expect(refs.ticketId(db, ticket.id)).toBe(ticket.id);
		expect(refs.ticketId(db, String(ticket.id))).toBe(ticket.id);
	});

	it('resolves a former key after a move and after a Project key rename', () => {
		const am = seedProject(db, 'AM');
		const ops = seedProject(db, 'OPS');
		const ticket = seedTicket(db, { projectId: am.id });
		moveTicket(db, seedActor(db), ticket.id, { projectId: ops.id });
		renameProjectKey(db, seedActor(db), ops.id, 'OP');

		for (const key of ['am-1', 'OPS-1', 'op-1']) expect(refs.ticketId(db, key)).toBe(ticket.id);
	});

	it('tells a malformed reference from a missing Ticket', () => {
		seedProject(db, 'AM');

		expect(failure(() => refs.ticketId(db, 'not a key'))).toMatchObject({
			code: 'invalid',
			message: '"not a key" is neither a Ticket key nor a Ticket id'
		});
		expect(failure(() => refs.ticketId(db, 'am-9'))).toMatchObject({
			code: 'not_found',
			message: 'No Ticket has the key AM-9'
		});
		expect(failure(() => refs.ticketId(db, 999))).toMatchObject({ code: 'not_found' });
	});
});

describe('projectId and userId', () => {
	it('resolves a Project by current key, former key or id', () => {
		const project = seedProject(db, 'AM');
		renameProjectKey(db, seedActor(db), project.id, 'AX');

		expect(refs.projectId(db, 'ax')).toBe(project.id);
		expect(refs.projectId(db, 'am')).toBe(project.id);
		expect(refs.projectId(db, project.id)).toBe(project.id);
		expect(failure(() => refs.projectId(db, 'ZZ'))).toMatchObject({ code: 'not_found' });
	});

	it('resolves a User by username in any case, or id', () => {
		const id = seedUser(db, 'ada');

		expect(refs.userId(db, 'Ada')).toBe(id);
		expect(refs.userId(db, id)).toBe(id);
		expect(refs.userId(db, `${id}`)).toBe(id);
		expect(failure(() => refs.userId(db, 'nobody'))).toMatchObject({ code: 'not_found' });
	});

	it('names a Quest by id only', () => {
		const quest = createQuest(db, seedActor(db), { name: 'Q', ownerId: seedUser(db) });

		expect(refs.questId(db, quest.id)).toBe(quest.id);
		expect(refs.questId(db, String(quest.id))).toBe(quest.id);
		expect(failure(() => refs.questId(db, 'Q'))).toMatchObject({ code: 'invalid' });
	});
});

describe('stateId and substateId', () => {
	it('resolves a State key within its Project, and lists the keys when it is missing', () => {
		const project = seedProject(db, 'AM');
		const todo = listStates(db, project.id).find((s) => s.key === 'todo')!;

		expect(refs.stateId(db, project.id, 'TODO')).toBe(todo.id);
		expect(refs.stateId(db, undefined, todo.id)).toBe(todo.id);
		expect(failure(() => refs.stateId(db, project.id, 'doing'))).toMatchObject({
			code: 'not_found',
			message: 'No State "doing" in AM; its States are todo, closed'
		});
	});

	it('needs the Project for a key, and rejects an id from another Project', () => {
		const am = seedProject(db, 'AM');
		const ops = seedProject(db, 'OPS');
		const opsTodo = listStates(db, ops.id)[0];

		expect(failure(() => refs.stateId(db, undefined, 'todo'))).toMatchObject({
			code: 'invalid'
		});
		expect(failure(() => refs.stateId(db, am.id, opsTodo.id))).toMatchObject({
			code: 'invalid',
			message: 'The State belongs to another Project'
		});
	});

	it('resolves a Substate key within its State', () => {
		const project = seedProject(db, 'AM');
		const todo = listStates(db, project.id)[0];
		const ready = createSubstate(db, seedActor(db), todo.id, style('ready'));

		expect(refs.substateId(db, todo.id, 'ready')).toBe(ready.id);
		expect(refs.substateId(db, undefined, ready.id)).toBe(ready.id);
		expect(failure(() => refs.substateId(db, todo.id, 'done'))).toMatchObject({
			code: 'not_found',
			message: 'No Substate "done" in State "todo"; its Substates are ready'
		});
		expect(failure(() => refs.substateId(db, undefined, 'ready'))).toMatchObject({
			code: 'invalid'
		});
	});
});

describe('placement', () => {
	it('takes at most one of position, before and after, resolving Ticket references', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		expect(refs.placement(db, {})).toBeUndefined();
		expect(refs.placement(db, { position: 'top' })).toBe('top');
		expect(refs.placement(db, { before: 'am-1' })).toEqual({ before: ticket.id });
		expect(refs.placement(db, { after: ticket.id })).toEqual({ after: ticket.id });
		expect(failure(() => refs.placement(db, { position: 'top', after: 'AM-1' }))).toMatchObject({
			code: 'invalid'
		});
	});
});
