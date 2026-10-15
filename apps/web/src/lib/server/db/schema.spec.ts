import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.ts';
import {
	projectKeyAliases,
	projects,
	states,
	substates,
	ticketKeyAliases,
	tickets,
	users
} from './schema.ts';
import { testDb } from '#lib/server/test/db.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

const human = (username = 'ada') => ({
	kind: 'human' as const,
	username,
	displayName: username,
	passwordHash: 'hash'
});

const agent = (username = 'bot') => ({
	kind: 'agent' as const,
	username,
	displayName: username
});

const addUser = (values: typeof users.$inferInsert) =>
	db.insert(users).values(values).returning().get();

const addProject = (key = 'AM', name = 'Amber') =>
	db.insert(projects).values({ name, key }).returning().get();

const addState = (
	projectId: number,
	values: Partial<typeof states.$inferInsert> & { key: string; position: number }
) =>
	db
		.insert(states)
		.values({ label: values.key, color: '#000000', icon: 'dot', projectId, ...values })
		.returning()
		.get();

const addSubstate = (stateId: number, key: string, position: number) =>
	db
		.insert(substates)
		.values({ stateId, key, label: key, color: '#000000', icon: 'dot', position })
		.returning()
		.get();

const addTicket = (
	values: Omit<typeof tickets.$inferInsert, 'number' | 'title'> & { number?: number }
) =>
	db
		.insert(tickets)
		.values({ number: 1, title: 'ticket', ...values })
		.returning()
		.get();

describe('users', () => {
	it('stores a human with a password and an agent without one', () => {
		expect(addUser(human()).id).toBeTypeOf('number');
		expect(addUser(agent()).id).toBeTypeOf('number');
	});

	it('rejects a human without a password hash', () => {
		expect(() => addUser({ ...human(), passwordHash: null })).toThrow();
	});

	it('rejects an agent that has a password hash', () => {
		expect(() => addUser({ ...agent(), passwordHash: 'hash' })).toThrow();
	});

	it('rejects an agent flagged as Admin', () => {
		expect(() => addUser({ ...agent(), isAdmin: true })).toThrow();
	});

	it('rejects a kind other than human or agent', () => {
		expect(() => addUser({ ...human(), kind: 'robot' as 'human' })).toThrow();
	});

	it('rejects a username that is not lowercase, and a duplicate one', () => {
		expect(() => addUser(human('Ada'))).toThrow();
		addUser(human('ada'));
		expect(() => addUser(human('ada'))).toThrow();
	});
});

describe('projects', () => {
	it('rejects a project key that is not uppercase letters and digits of 2 to 6 characters', () => {
		expect(() => addProject('am')).toThrow();
		expect(() => addProject('A')).toThrow();
		expect(() => addProject('AAAAAAA')).toThrow();
		expect(() => addProject('1AB')).toThrow();
		expect(() => addProject('A-B')).toThrow();
		expect(addProject('A1B2C3').key).toBe('A1B2C3');
	});

	it('rejects a duplicate project key', () => {
		addProject('AM');
		expect(() => addProject('AM', 'Other')).toThrow();
	});

	it('rejects an Initial State that belongs to another project', () => {
		const first = addProject('AM');
		const second = addProject('BL');
		const state = addState(first.id, { key: 'todo', position: 0 });

		expect(() =>
			db.update(projects).set({ initialStateId: state.id }).where(eq(projects.id, second.id)).run()
		).toThrow();
		db.update(projects).set({ initialStateId: state.id }).where(eq(projects.id, first.id)).run();
	});
});

describe('states', () => {
	it('allows one Closed State per project', () => {
		const project = addProject();
		addState(project.id, { key: 'closed', position: 0, isClosed: true });

		expect(() => addState(project.id, { key: 'done', position: 1, isClosed: true })).toThrow();
		expect(
			addState(addProject('BL').id, { key: 'closed', position: 0, isClosed: true }).id
		).toBeTypeOf('number');
	});

	it('gives each State of a project a distinct position and key', () => {
		const project = addProject();
		addState(project.id, { key: 'todo', position: 0 });

		expect(() => addState(project.id, { key: 'other', position: 0 })).toThrow();
		expect(() => addState(project.id, { key: 'todo', position: 1 })).toThrow();
	});

	it('gives each Substate of a State a distinct position and key', () => {
		const project = addProject();
		const state = addState(project.id, { key: 'todo', position: 0 });
		addSubstate(state.id, 'review', 0);

		expect(() => addSubstate(state.id, 'other', 0)).toThrow();
		expect(() => addSubstate(state.id, 'review', 1)).toThrow();
	});

	it('removes Substates and clears the default when the State is deleted', () => {
		const project = addProject();
		const state = addState(project.id, { key: 'todo', position: 0 });
		addSubstate(state.id, 'review', 0);

		db.delete(states).where(eq(states.id, state.id)).run();

		expect(db.select().from(substates).all()).toEqual([]);
	});
});

describe('tickets', () => {
	const setup = () => {
		const project = addProject();
		const state = addState(project.id, { key: 'todo', position: 0 });
		const owner = addUser(human());
		return { project, state, owner };
	};

	it('rejects a State from another project', () => {
		const { project, owner } = setup();
		const otherState = addState(addProject('BL').id, { key: 'todo', position: 0 });

		expect(() =>
			addTicket({ projectId: project.id, stateId: otherState.id, ownerId: owner.id })
		).toThrow();
	});

	it('rejects a Substate that belongs to another State', () => {
		const { project, state, owner } = setup();
		const other = addState(project.id, { key: 'doing', position: 1 });
		const foreign = addSubstate(other.id, 'review', 0);

		expect(() =>
			addTicket({
				projectId: project.id,
				stateId: state.id,
				substateId: foreign.id,
				ownerId: owner.id
			})
		).toThrow();
	});

	it('rejects a number below 1 and a repeated number within a project', () => {
		const { project, state, owner } = setup();

		expect(() =>
			addTicket({ projectId: project.id, stateId: state.id, ownerId: owner.id, number: 0 })
		).toThrow();
		addTicket({ projectId: project.id, stateId: state.id, ownerId: owner.id, number: 1 });
		expect(() =>
			addTicket({ projectId: project.id, stateId: state.id, ownerId: owner.id, number: 1 })
		).toThrow();
	});

	it('clears the Parent of children when the Parent is deleted', () => {
		const { project, state, owner } = setup();
		const parent = addTicket({ projectId: project.id, stateId: state.id, ownerId: owner.id });
		const child = addTicket({
			projectId: project.id,
			stateId: state.id,
			ownerId: owner.id,
			number: 2,
			parentId: parent.id
		});

		db.delete(tickets).where(eq(tickets.id, parent.id)).run();

		expect(db.select().from(tickets).where(eq(tickets.id, child.id)).get()?.parentId).toBeNull();
	});

	it('deletes a project with its States, Tickets and aliases', () => {
		const { project, state, owner } = setup();
		const ticket = addTicket({ projectId: project.id, stateId: state.id, ownerId: owner.id });
		addSubstate(state.id, 'review', 0);
		db.update(projects).set({ initialStateId: state.id }).where(eq(projects.id, project.id)).run();
		db.insert(ticketKeyAliases).values({ key: 'AM-9', ticketId: ticket.id }).run();
		db.insert(projectKeyAliases).values({ key: 'OLD', projectId: project.id }).run();

		db.delete(projects).where(eq(projects.id, project.id)).run();

		expect(db.select().from(states).all()).toEqual([]);
		expect(db.select().from(tickets).all()).toEqual([]);
		expect(db.select().from(ticketKeyAliases).all()).toEqual([]);
		expect(db.select().from(projectKeyAliases).all()).toEqual([]);
	});
});

describe('key aliases', () => {
	it('stores ticket and project keys in uppercase only', () => {
		const project = addProject();
		const state = addState(project.id, { key: 'todo', position: 0 });
		const ticket = addTicket({
			projectId: project.id,
			stateId: state.id,
			ownerId: addUser(human()).id
		});

		expect(() =>
			db.insert(projectKeyAliases).values({ key: 'old', projectId: project.id }).run()
		).toThrow();
		expect(() =>
			db.insert(ticketKeyAliases).values({ key: 'am-1', ticketId: ticket.id }).run()
		).toThrow();
	});
});
