import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, tickets } from '#lib/server/db/schema.ts';
import { subscribe } from '#lib/server/events/bus.ts';
import { eventsSince } from '#lib/server/events/log.ts';
import type { WorkloadEvent } from '#lib/server/events/types.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket, seedUser, TODO } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	addQuestTicket,
	addQuestTicketWithChildren,
	createQuest,
	deleteQuest,
	rankQuestTicket,
	readQuest,
	removeQuestTicket,
	updateQuest
} from './quests.ts';
import {
	createProject,
	deleteProject,
	readProject,
	renameProjectKey,
	setInitialState,
	updateProject
} from './projects.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	listStates,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	updateState,
	updateSubstate
} from './states.ts';
import {
	createTicket,
	deleteTicket,
	moveTicket,
	rankTicket,
	readTicket,
	setParent,
	updateTicket
} from './tickets.ts';
import type { Actor } from './write.ts';

let db: Db;
let actor: Actor;
let published: WorkloadEvent[];
let unsubscribe: () => void;

beforeEach(() => {
	db = testDb();
	actor = { id: seedUser(db, 'writer') };
	published = [];
	unsubscribe = subscribe((event) => published.push(event));
});

afterEach(() => {
	unsubscribe();
	db.$client.close();
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const lastSeq = () => db.select().from(events).all().at(-1)?.seq ?? 0;

// Runs one write and returns the Events it recorded.
function recorded(action: () => unknown): WorkloadEvent[] {
	const before = lastSeq();
	published = [];
	action();
	return eventsSince(db, before);
}

function expectOneEvent(action: () => unknown): WorkloadEvent {
	const found = recorded(action);
	expect(found).toHaveLength(1);
	expect(published).toEqual(found);
	expect(found[0].actorId).toBe(actor.id);
	return found[0];
}

describe('Project config writes', () => {
	it('records one Event per write, by the actor, with the Project config as its snapshot', () => {
		const project = seedProject(db, 'AM');
		const todo = project.initialStateId!;
		let doingId = 0;
		let reviewId = 0;
		let qaId = 0;

		const cases: [string, () => void][] = [
			['project.updated', () => updateProject(db, actor, project.id, { name: 'Amber' })],
			['project.updated', () => renameProjectKey(db, actor, project.id, 'AB')],
			['state.created', () => (doingId = createState(db, actor, project.id, style('doing')).id)],
			['state.updated', () => updateState(db, actor, doingId, { label: 'Doing' })],
			['state.updated', () => moveState(db, actor, doingId, 0)],
			['project.updated', () => setInitialState(db, actor, project.id, doingId)],
			['substate.created', () => (reviewId = createSubstate(db, actor, todo, style('review')).id)],
			['substate.created', () => (qaId = createSubstate(db, actor, todo, style('qa')).id)],
			['substate.updated', () => updateSubstate(db, actor, qaId, { color: '#ffffff' })],
			['substate.updated', () => moveSubstate(db, actor, qaId, 0)],
			['state.updated', () => setDefaultSubstate(db, actor, todo, qaId)],
			['substate.deleted', () => deleteSubstate(db, actor, reviewId)]
		];

		for (const [type, action] of cases) {
			const event = expectOneEvent(action);
			expect(event.type, type).toBe(type);
			expect(event.projectIds).toEqual([project.id]);
			expect(event.snapshot).toEqual(json(readProject(db, project.id)));
		}
	});

	it('names the State and Substate a config Event is about', () => {
		const project = seedProject(db, 'AM');
		const todo = project.initialStateId!;

		const sub = expectOneEvent(() => createSubstate(db, actor, todo, style('review')));
		const doing = createState(db, actor, project.id, style('doing'));
		const removed = expectOneEvent(() => deleteState(db, actor, doing.id));

		expect(sub.entityIds).toEqual({
			projectId: project.id,
			stateId: todo,
			substateId: (sub.snapshot as { states: { substates: { id: number }[] }[] }).states[0]
				.substates[0].id
		});
		expect(removed).toMatchObject({
			type: 'state.deleted',
			entityIds: { projectId: project.id, stateId: doing.id }
		});
	});

	it('records project.created and project.deleted, with no snapshot once the Project is gone', () => {
		let projectId = 0;
		const created = expectOneEvent(
			() =>
				(projectId = createProject(db, actor, { name: 'Amber', key: 'AM', initialState: TODO }).id)
		);
		const config = json(readProject(db, projectId));
		const deleted = expectOneEvent(() => deleteProject(db, actor, projectId));

		expect(created).toMatchObject({ type: 'project.created', entityIds: { projectId } });
		expect(created.snapshot).toEqual(config);
		expect(deleted).toMatchObject({
			type: 'project.deleted',
			entityIds: { projectId },
			projectIds: [projectId],
			snapshot: null
		});
	});
});

describe('Ticket writes', () => {
	it('records one Event per write, by the actor, with the Ticket and its current key', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const ownerId = seedUser(db, 'ada');
		const parent = seedTicket(db, { projectId: bl.id, ownerId });
		let ticketId = 0;

		const created = expectOneEvent(
			() => (ticketId = createTicket(db, actor, { projectId: am.id, title: 'Fix', ownerId }).id)
		);
		expect(created).toMatchObject({
			type: 'ticket.created',
			entityIds: { ticketId },
			projectIds: [am.id]
		});
		expect(created.snapshot).toEqual(json(readTicket(db, ticketId)));
		expect((created.snapshot as { key: string }).key).toBe('AM-1');

		const updated = expectOneEvent(() => updateTicket(db, actor, ticketId, { title: 'Fixed' }));
		expect(updated).toMatchObject({ type: 'ticket.updated', snapshot: { title: 'Fixed' } });

		seedTicket(db, { projectId: am.id, ownerId });
		const ranked = expectOneEvent(() => rankTicket(db, actor, ticketId, 'bottom'));
		expect(ranked).toMatchObject({
			type: 'ticket.ranked',
			snapshot: { rank: readTicket(db, ticketId).rank }
		});

		const reparented = expectOneEvent(() => setParent(db, actor, ticketId, parent.id));
		expect(reparented).toMatchObject({
			type: 'ticket.reparented',
			projectIds: [am.id, bl.id],
			snapshot: { parentId: parent.id }
		});

		const moved = expectOneEvent(() => moveTicket(db, actor, ticketId, { projectId: bl.id }));
		expect(moved).toMatchObject({
			type: 'ticket.moved',
			projectIds: [am.id, bl.id],
			snapshot: { key: 'BL-2', projectId: bl.id }
		});

		const deleted = expectOneEvent(() => deleteTicket(db, actor, parent.id));
		expect(deleted).toMatchObject({
			type: 'ticket.deleted',
			entityIds: { ticketId: parent.id },
			projectIds: [bl.id],
			snapshot: null
		});
	});

	it('records the Projects of the Children a deleted Ticket leaves without a Parent', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const parent = seedTicket(db, { projectId: am.id });
		seedTicket(db, { projectId: bl.id, parentId: parent.id });

		const deleted = expectOneEvent(() => deleteTicket(db, actor, parent.id));

		expect(deleted.projectIds).toEqual([am.id, bl.id]);
	});
});

describe('Quest writes', () => {
	it('records one Event per write, by the actor, with the Quest and every Project it touches', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const a = seedTicket(db, { projectId: am.id });
		const b = seedTicket(db, { projectId: bl.id });
		seedTicket(db, { projectId: bl.id, parentId: b.id });
		let questId = 0;

		const cases: [string, () => unknown, number[]][] = [
			[
				'quest.created',
				() => (questId = createQuest(db, actor, { name: 'Launch', ownerId: actor.id }).id),
				[]
			],
			['quest.updated', () => updateQuest(db, actor, questId, { name: 'Ship' }), []],
			['quest.tickets_added', () => addQuestTicket(db, actor, questId, a.id), [am.id]],
			[
				'quest.tickets_added',
				() => addQuestTicketWithChildren(db, actor, questId, b.id),
				[am.id, bl.id]
			],
			[
				'quest.ticket_ranked',
				() => rankQuestTicket(db, actor, questId, a.id, 'bottom'),
				[am.id, bl.id]
			],
			['quest.ticket_removed', () => removeQuestTicket(db, actor, questId, a.id), [am.id, bl.id]]
		];
		for (const [type, action, projectIds] of cases) {
			const event = expectOneEvent(action);
			expect(event.type, type).toBe(type);
			expect(event.entityIds.questId).toBe(questId);
			expect(event.projectIds, type).toEqual(projectIds);
			expect(event.snapshot).toEqual(json(readQuest(db, questId)));
		}

		const deleted = expectOneEvent(() => deleteQuest(db, actor, questId));
		expect(deleted).toMatchObject({
			type: 'quest.deleted',
			entityIds: { questId },
			projectIds: [bl.id],
			snapshot: null
		});
	});

	it('names the Tickets a membership Event is about', () => {
		const project = seedProject(db, 'AM');
		const parent = seedTicket(db, { projectId: project.id });
		const child = seedTicket(db, { projectId: project.id, parentId: parent.id });
		const quest = createQuest(db, actor, { name: 'Launch', ownerId: actor.id });

		const added = expectOneEvent(() => addQuestTicketWithChildren(db, actor, quest.id, parent.id));
		const removed = expectOneEvent(() => removeQuestTicket(db, actor, quest.id, child.id));

		expect(added.entityIds).toEqual({ questId: quest.id, ticketIds: [parent.id, child.id] });
		expect(removed.entityIds).toEqual({ questId: quest.id, ticketId: child.id });
	});
});

describe('no-op writes', () => {
	it('records no Event for a write that changes nothing', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id, title: 'Same' });

		const found = recorded(() => {
			updateProject(db, actor, project.id, { name: project.name });
			renameProjectKey(db, actor, project.id, 'am');
			setInitialState(db, actor, project.id, project.initialStateId!);
			updateState(db, actor, project.initialStateId!, { label: TODO.label });
			moveState(db, actor, project.initialStateId!, 0);
			updateTicket(db, actor, ticket.id, { title: 'Same', stateId: ticket.stateId });
			setParent(db, actor, ticket.id, null);
		});

		expect(found).toEqual([]);
		expect(published).toEqual([]);
	});
});

describe('failed writes', () => {
	it('leaves no Event and publishes nothing when a write is refused', () => {
		const project = seedProject(db, 'AM');
		const ticket = seedTicket(db, { projectId: project.id });

		const found = recorded(() => {
			for (const action of [
				() => createTicket(db, actor, { projectId: project.id, title: 'x', ownerId: 999 }),
				() => setParent(db, actor, ticket.id, ticket.id),
				() => deleteState(db, actor, listStates(db, project.id).at(-1)!.id),
				() => renameProjectKey(db, actor, project.id, '1')
			]) {
				expect(action).toThrow(DomainError);
			}
		});

		expect(found).toEqual([]);
		expect(published).toEqual([]);
	});

	it('rolls back the write with its Event when recording the Event fails', () => {
		const project = seedProject(db, 'AM');
		const ghost = { id: 999 };
		const before = db.select().from(tickets).all();

		const found = recorded(() =>
			expect(() =>
				createTicket(db, ghost, { projectId: project.id, title: 'x', ownerId: actor.id })
			).toThrow()
		);

		expect(found).toEqual([]);
		expect(published).toEqual([]);
		expect(db.select().from(tickets).all()).toEqual(before);
	});
});

describe('publishing', () => {
	it('publishes each Event after its commit, in seq order, as stored', () => {
		const project = seedProject(db, 'AM');
		let seenInside: number | undefined;
		const stop = subscribe(() => {
			seenInside ??= db.$client.inTransaction ? 1 : 0;
		});

		seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });
		stop();

		expect(seenInside).toBe(0);
		const stored = eventsSince(db, 0);
		expect(published).toEqual(stored.slice(-published.length));
		expect(published.map((e) => e.seq)).toEqual(
			[...published.map((e) => e.seq)].sort((a, b) => a - b)
		);
	});
});
