import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, quests, tickets, users } from '#lib/server/db/schema.ts';
import { subscribe } from '#lib/server/events/bus.ts';
import { eventsSince } from '#lib/server/events/log.ts';
import type { WorkloadEvent } from '#lib/server/events/types.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket, seedUser, TODO } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	addQuestTicket,
	addQuestTickets,
	addQuestTicketWithChildren,
	createQuest,
	deleteQuest,
	rankQuestTicket,
	readQuest,
	removeQuestTicket,
	removeQuestTickets,
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
	actor = {
		id: db
			.insert(users)
			.values({ kind: 'agent', username: 'writer', displayName: 'The Writer' })
			.returning()
			.get().id
	};
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

// Runs one write and returns the Events it recorded, after checking they were published as stored.
function recorded(action: () => unknown): WorkloadEvent[] {
	const before = lastSeq();
	published = [];
	action();
	const found = eventsSince(db, before);
	expect(published).toEqual(found);
	return found;
}

function expectOneEvent(action: () => unknown): WorkloadEvent {
	const found = recorded(action);
	expect(found).toHaveLength(1);
	return found[0];
}

const shape = (found: WorkloadEvent[]) => found.map((e) => [e.type, e.data]);

describe('the Event record', () => {
	it("carries the seq, type, time, the actor's display info and the data", () => {
		const event = expectOneEvent(() =>
			createProject(db, actor, { name: 'Amber', key: 'AM', initialState: TODO })
		);

		expect(Object.keys(event).sort()).toEqual(['actor', 'createdAt', 'data', 'seq', 'type']);
		expect(event.actor).toEqual({
			id: actor.id,
			kind: 'agent',
			username: 'writer',
			displayName: 'The Writer'
		});
		expect(event.createdAt).toBeInstanceOf(Date);
	});
});

describe('Project config writes', () => {
	it('record one Event each, carrying the Project config and the State or Substate they touch', () => {
		const project = seedProject(db, 'AM');
		const todo = project.initialStateId!;
		let doingId = 0;
		let reviewId = 0;
		let qaId = 0;
		const config = () => json(readProject(db, project.id));

		const cases: [string, () => void, () => object][] = [
			[
				'project.updated',
				() => updateProject(db, actor, project.id, { name: 'Amber' }),
				() => ({ project: config() })
			],
			[
				'state.created',
				() => (doingId = createState(db, actor, project.id, style('doing')).id),
				() => ({ project: config(), stateId: doingId })
			],
			[
				'state.updated',
				() => updateState(db, actor, doingId, { label: 'Doing' }),
				() => ({ project: config(), stateId: doingId })
			],
			[
				'state.updated',
				() => moveState(db, actor, doingId, 0),
				() => ({ project: config(), stateId: doingId })
			],
			[
				'project.updated',
				() => setInitialState(db, actor, project.id, doingId),
				() => ({ project: config() })
			],
			[
				'substate.created',
				() => (reviewId = createSubstate(db, actor, todo, style('review')).id),
				() => ({ project: config(), stateId: todo, substateId: reviewId })
			],
			[
				'substate.created',
				() => (qaId = createSubstate(db, actor, todo, style('qa')).id),
				() => ({ project: config(), stateId: todo, substateId: qaId })
			],
			[
				'substate.updated',
				() => updateSubstate(db, actor, qaId, { color: '#ffffff' }),
				() => ({ project: config(), stateId: todo, substateId: qaId })
			],
			[
				'substate.updated',
				() => moveSubstate(db, actor, qaId, 0),
				() => ({ project: config(), stateId: todo, substateId: qaId })
			],
			[
				'state.updated',
				() => setDefaultSubstate(db, actor, todo, qaId),
				() => ({ project: config(), stateId: todo })
			],
			[
				'substate.deleted',
				() => deleteSubstate(db, actor, reviewId),
				() => ({ project: config(), stateId: todo, substateId: reviewId })
			],
			[
				'state.deleted',
				() => {
					setInitialState(db, actor, project.id, todo);
					deleteState(db, actor, doingId);
				},
				() => ({ project: config(), stateId: doingId })
			]
		];

		for (const [type, action, data] of cases) {
			const found = recorded(action);
			const event = found.at(-1)!;
			expect(event.type, type).toBe(type);
			expect(event.data, type).toEqual(data());
		}
	});

	it('records project.created with the config, and project.deleted with the Tickets it took', () => {
		let projectId = 0;
		const created = expectOneEvent(
			() =>
				(projectId = createProject(db, actor, { name: 'Amber', key: 'AM', initialState: TODO }).id)
		);
		expect(created).toMatchObject({
			type: 'project.created',
			data: { project: json(readProject(db, projectId)) }
		});
		const a = seedTicket(db, { projectId });
		const b = seedTicket(db, { projectId, parentId: a.id });

		const deleted = expectOneEvent(() => deleteProject(db, actor, projectId));

		expect(deleted).toMatchObject({
			type: 'project.deleted',
			data: { projectId, ticketIds: [a.id, b.id] }
		});
	});

	it('records the new key of every Ticket in a Project whose key is renamed', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		const b = seedTicket(db, { projectId: project.id });

		const found = recorded(() => renameProjectKey(db, actor, project.id, 'AB'));

		expect(shape(found)).toEqual([
			['project.updated', { project: json(readProject(db, project.id)) }],
			[
				'ticket.rekeyed',
				{
					projectId: project.id,
					tickets: [
						{ id: a.id, previousKey: 'AM-1', key: 'AB-1' },
						{ id: b.id, previousKey: 'AM-2', key: 'AB-2' }
					]
				}
			]
		]);
	});

	it("records each Ticket a State's first Substate takes in, with its updatedAt moved", () => {
		const project = seedProject(db, 'AM');
		const todo = project.initialStateId!;
		const a = seedTicket(db, { projectId: project.id });
		const b = seedTicket(db, { projectId: project.id });
		db.update(tickets)
			.set({ updatedAt: new Date(0) })
			.run();
		let substateId = 0;

		const found = recorded(() => (substateId = createSubstate(db, actor, todo, style('rev')).id));

		expect(shape(found)).toEqual([
			[
				'substate.created',
				{ project: json(readProject(db, project.id)), stateId: todo, substateId }
			],
			['ticket.updated', { ticket: json(readTicket(db, a.id)) }],
			['ticket.updated', { ticket: json(readTicket(db, b.id)) }]
		]);
		expect(readTicket(db, a.id)).toMatchObject({ substateId });
		expect(readTicket(db, a.id).updatedAt.getTime()).toBeGreaterThan(0);
	});

	it('records the Children it detaches in other Projects and the Quests it shrinks when deleting a Project', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const parent = seedTicket(db, { projectId: am.id });
		const child = seedTicket(db, { projectId: bl.id, parentId: parent.id });
		const quest = createQuest(db, actor, { name: 'Launch', ownerId: actor.id });
		addQuestTicket(db, actor, quest.id, parent.id);
		addQuestTicket(db, actor, quest.id, child.id);
		db.update(tickets)
			.set({ updatedAt: new Date(0) })
			.run();
		db.update(quests)
			.set({ updatedAt: new Date(0) })
			.run();

		const found = recorded(() => deleteProject(db, actor, am.id));

		const after = readQuest(db, quest.id);
		expect(shape(found)).toEqual([
			['project.deleted', { projectId: am.id, ticketIds: [parent.id] }],
			['ticket.reparented', { ticket: json(readTicket(db, child.id)) }],
			['quest.tickets_removed', { quest: json(after), ticketIds: [parent.id] }]
		]);
		expect(readTicket(db, child.id).parentId).toBeNull();
		expect(readTicket(db, child.id).updatedAt.getTime()).toBeGreaterThan(0);
		expect(after.progress).toEqual({ closed: 0, total: 1 });
		expect(after.updatedAt.getTime()).toBeGreaterThan(0);
	});
});

describe('Ticket writes', () => {
	it('record one Event each, carrying the Ticket with its current key', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const ownerId = seedUser(db, 'ada');
		const parent = seedTicket(db, { projectId: bl.id, ownerId });
		let ticketId = 0;
		const ticket = () => ({ ticket: json(readTicket(db, ticketId)) });

		const created = expectOneEvent(
			() => (ticketId = createTicket(db, actor, { projectId: am.id, title: 'Fix', ownerId }).id)
		);
		expect(created).toMatchObject({ type: 'ticket.created', data: ticket() });
		expect(ticket().ticket).toMatchObject({ key: 'AM-1', closed: false });

		const updated = expectOneEvent(() => updateTicket(db, actor, ticketId, { title: 'Fixed' }));
		expect(updated).toMatchObject({ type: 'ticket.updated', data: ticket() });

		const reparented = expectOneEvent(() => setParent(db, actor, ticketId, parent.id));
		expect(reparented).toMatchObject({ type: 'ticket.reparented', data: ticket() });

		const moved = expectOneEvent(() => moveTicket(db, actor, ticketId, { projectId: bl.id }));
		expect(moved).toMatchObject({ type: 'ticket.moved', data: ticket() });
		expect(ticket().ticket).toMatchObject({ key: 'BL-2', projectId: bl.id });
	});

	it('records a rank change as just the Ticket, its State and its new Rank', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });

		const ranked = expectOneEvent(() => rankTicket(db, actor, a.id, 'bottom'));

		expect(ranked).toMatchObject({
			type: 'ticket.ranked',
			data: { id: a.id, stateId: a.stateId, rank: readTicket(db, a.id).rank }
		});
		expect(Object.keys(ranked.data).sort()).toEqual(['id', 'rank', 'stateId']);
	});

	it('records an update that changes only the Rank as ticket.ranked', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });

		const ranked = expectOneEvent(() =>
			updateTicket(db, actor, a.id, { title: a.title, stateId: a.stateId, placement: 'bottom' })
		);

		expect(shape([ranked])).toEqual([
			['ticket.ranked', { id: a.id, stateId: a.stateId, rank: readTicket(db, a.id).rank }]
		]);
		expect(readTicket(db, a.id).updatedAt).toEqual(a.updatedAt);
	});

	it('records an update that changes the Rank with another field as ticket.updated', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });

		const updated = expectOneEvent(() =>
			updateTicket(db, actor, a.id, { title: 'Renamed', placement: 'bottom' })
		);

		expect(shape([updated])).toEqual([['ticket.updated', { ticket: json(readTicket(db, a.id)) }]]);
	});

	it('records the Children it detaches and the Quests it shrinks when deleting a Ticket', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const parent = seedTicket(db, { projectId: am.id });
		const near = seedTicket(db, { projectId: am.id, parentId: parent.id });
		const far = seedTicket(db, { projectId: bl.id, parentId: parent.id });
		const first = createQuest(db, actor, { name: 'One', ownerId: actor.id });
		const second = createQuest(db, actor, { name: 'Two', ownerId: actor.id });
		addQuestTicket(db, actor, first.id, parent.id);
		addQuestTicket(db, actor, second.id, far.id);
		addQuestTicket(db, actor, second.id, parent.id);
		db.update(quests)
			.set({ updatedAt: new Date(0) })
			.run();

		const found = recorded(() => deleteTicket(db, actor, parent.id));

		expect(shape(found)).toEqual([
			['ticket.deleted', { id: parent.id, projectId: am.id }],
			['ticket.reparented', { ticket: json(readTicket(db, near.id)) }],
			['ticket.reparented', { ticket: json(readTicket(db, far.id)) }],
			['quest.tickets_removed', { quest: json(readQuest(db, first.id)), ticketIds: [parent.id] }],
			['quest.tickets_removed', { quest: json(readQuest(db, second.id)), ticketIds: [parent.id] }]
		]);
		expect(readTicket(db, far.id).parentId).toBeNull();
		expect(readQuest(db, first.id).updatedAt.getTime()).toBeGreaterThan(0);
	});
});

describe('Quest writes', () => {
	it('record one Event each, carrying the Quest with its member Tickets in order', () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const a = seedTicket(db, { projectId: am.id });
		const b = seedTicket(db, { projectId: bl.id });
		const c = seedTicket(db, { projectId: bl.id, parentId: b.id });
		let questId = 0;
		const quest = () => json(readQuest(db, questId));

		const cases: [string, () => unknown, () => object][] = [
			[
				'quest.created',
				() => (questId = createQuest(db, actor, { name: 'Launch', ownerId: actor.id }).id),
				() => ({ quest: quest() })
			],
			[
				'quest.updated',
				() => updateQuest(db, actor, questId, { name: 'Ship' }),
				() => ({ quest: quest() })
			],
			[
				'quest.tickets_added',
				() => addQuestTicket(db, actor, questId, a.id),
				() => ({ quest: quest(), ticketIds: [a.id] })
			],
			[
				'quest.tickets_added',
				() => addQuestTicketWithChildren(db, actor, questId, b.id),
				() => ({ quest: quest(), ticketIds: [b.id, c.id] })
			],
			[
				'quest.ticket_ranked',
				() => rankQuestTicket(db, actor, questId, a.id, 'bottom'),
				() => ({ quest: quest(), ticketId: a.id })
			],
			[
				'quest.tickets_removed',
				() => removeQuestTicket(db, actor, questId, a.id),
				() => ({ quest: quest(), ticketIds: [a.id] })
			]
		];
		for (const [type, action, data] of cases) {
			const event = expectOneEvent(action);
			expect(event.type, type).toBe(type);
			expect(event.data, type).toEqual(data());
		}
		expect(quest().tickets.map((t: { id: number }) => t.id)).toEqual([b.id, c.id]);

		const deleted = expectOneEvent(() => deleteQuest(db, actor, questId));
		expect(deleted).toMatchObject({ type: 'quest.deleted', data: { id: questId } });
	});
});

describe('bulk Quest membership', () => {
	it('records one Event per call, naming only the Tickets that changed', () => {
		const project = seedProject(db, 'AM');
		const [a, b, c] = [1, 2, 3].map(() => seedTicket(db, { projectId: project.id }));
		const questId = createQuest(db, actor, { name: 'Launch', ownerId: actor.id }).id;
		addQuestTicket(db, actor, questId, b.id);
		const quest = () => json(readQuest(db, questId));

		const added = recorded(() => addQuestTickets(db, actor, questId, [a.id, b.id, c.id]));
		expect(shape(added)).toEqual([
			['quest.tickets_added', { quest: quest(), ticketIds: [a.id, c.id] }]
		]);

		const removed = recorded(() => removeQuestTickets(db, actor, questId, [c.id, a.id]));
		expect(shape(removed)).toEqual([
			['quest.tickets_removed', { quest: quest(), ticketIds: [c.id, a.id] }]
		]);
	});

	it('records no Event when every Ticket is skipped', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		const questId = createQuest(db, actor, { name: 'Launch', ownerId: actor.id }).id;
		addQuestTicket(db, actor, questId, a.id);

		const found = recorded(() => {
			addQuestTickets(db, actor, questId, [a.id]);
			removeQuestTickets(db, actor, questId, [seedTicket(db, { projectId: project.id }).id]);
		});

		expect(found.filter((e) => e.type.startsWith('quest.'))).toEqual([]);
	});

	it('records nothing when a Ticket is unknown', () => {
		const project = seedProject(db, 'AM');
		const a = seedTicket(db, { projectId: project.id });
		const questId = createQuest(db, actor, { name: 'Launch', ownerId: actor.id }).id;

		const found = recorded(() =>
			expect(() => addQuestTickets(db, actor, questId, [a.id, 999])).toThrow(DomainError)
		);

		expect(found).toEqual([]);
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
	});

	it('rolls back the write with its Events when recording them fails', () => {
		const project = seedProject(db, 'AM');
		const ghost = { id: 999 };
		const before = db.select().from(tickets).all();

		const found = recorded(() =>
			expect(() =>
				createTicket(db, ghost, { projectId: project.id, title: 'x', ownerId: actor.id })
			).toThrow()
		);

		expect(found).toEqual([]);
		expect(db.select().from(tickets).all()).toEqual(before);
	});
});

describe('publishing', () => {
	it("publishes a write's Events after its commit, with consecutive seqs, as stored", () => {
		const am = seedProject(db, 'AM');
		const bl = seedProject(db, 'BL');
		const parent = seedTicket(db, { projectId: am.id });
		seedTicket(db, { projectId: bl.id, parentId: parent.id });
		const inside: boolean[] = [];
		const stop = subscribe(() => inside.push(db.$client.inTransaction));

		const found = recorded(() => deleteProject(db, actor, am.id));
		stop();

		expect(found.length).toBeGreaterThan(1);
		expect(inside).toEqual(found.map(() => false));
		const first = found[0].seq;
		expect(found.map((e) => e.seq)).toEqual(found.map((_, i) => first + i));
	});
});
