import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client.ts';
import { addQuestTicket, createQuest } from '../domain/quests.ts';
import type { Actor } from '../domain/write.ts';
import { testDb } from '../test/db.ts';
import { seedActor, seedProject, seedTicket, seedUser } from '../test/fixtures.ts';
import { readHome, readTicketPage } from './reads.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

function statements(read: () => unknown): number {
	const prepare = vi.spyOn(db.$client, 'prepare');
	read();
	const count = prepare.mock.calls.length;
	prepare.mockRestore();
	return count;
}

function questsWithMembers(ownerId: number, count: number, projectId: number) {
	for (let i = 0; i < count; i++) {
		const quest = createQuest(db, actor, { name: `Quest ${i}`, ownerId });
		for (let j = 0; j < 3; j++) {
			addQuestTicket(db, actor, quest.id, seedTicket(db, { projectId, ownerId }).id);
		}
	}
}

describe('page reads', () => {
	it('read a Ticket page in as many statements however many Quests exist', () => {
		const project = seedProject(db);
		const ticket = seedTicket(db, { projectId: project.id, ownerId: actor.id });
		questsWithMembers(actor.id, 1, project.id);
		const few = statements(() => readTicketPage(db, ticket.id));

		questsWithMembers(actor.id, 12, project.id);
		expect(statements(() => readTicketPage(db, ticket.id))).toBe(few);
		expect(readTicketPage(db, ticket.id).quests).toHaveLength(13);
		expect(Object.keys(readTicketPage(db, ticket.id).quests[0]).sort()).toEqual(['id', 'name']);
	});

	it('read Home without touching the Quests other Users own', () => {
		const project = seedProject(db);
		const other = seedUser(db, 'other');
		questsWithMembers(actor.id, 2, project.id);
		const few = statements(() => readHome(db, actor.id));

		questsWithMembers(other, 12, project.id);
		expect(statements(() => readHome(db, actor.id))).toBe(few);
		expect(readHome(db, actor.id).quests.map((q) => q.ownerId)).toEqual([actor.id, actor.id]);
	});
});
