import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket } from '#lib/server/test/fixtures.ts';
import { canReplayFrom, eventsSince, eventWindow, pruneEvents } from './log.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

const DAY = 24 * 60 * 60 * 1000;

function age(seq: number, ms: number): void {
	db.$client.prepare('UPDATE events SET created_at = ? WHERE seq = ?').run(Date.now() - ms, seq);
}

describe('pruneEvents', () => {
	it('drops only Events older than the retention window', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		const [first, second] = eventsSince(db, 0);
		age(first.seq, 8 * DAY);
		age(second.seq, 6 * DAY);

		expect(pruneEvents(db, 7 * DAY)).toBe(1);

		expect(eventsSince(db, 0).map((e) => e.seq)).toEqual([second.seq]);
	});

	it('never reuses a seq after pruning empties the log', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		const last = eventsSince(db, 0).at(-1)!.seq;

		pruneEvents(db, 1, Date.now() + DAY);
		expect(db.select().from(events).all()).toEqual([]);
		seedTicket(db, { projectId: project.id });

		expect(eventsSince(db, 0).map((e) => e.seq)).toEqual([last + 1]);
	});
});

describe('eventWindow', () => {
	it('starts empty, replayable from zero', () => {
		const window = eventWindow(db);

		expect(window).toEqual({ oldest: 1, last: 0 });
		expect(canReplayFrom(window, 0)).toBe(true);
	});

	it('refuses a seq whose successors were pruned, and a seq never assigned', () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });
		const [first] = eventsSince(db, 0);
		age(first.seq, 8 * DAY);
		pruneEvents(db, 7 * DAY);

		const window = eventWindow(db);

		expect(window).toEqual({ oldest: first.seq + 1, last: first.seq + 2 });
		expect(canReplayFrom(window, first.seq - 1)).toBe(false);
		expect(canReplayFrom(window, first.seq)).toBe(true);
		expect(canReplayFrom(window, first.seq + 2)).toBe(true);
		expect(canReplayFrom(window, first.seq + 3)).toBe(false);
	});

	it('keeps the last seq once pruning empties the log', () => {
		seedProject(db, 'AM');
		pruneEvents(db, 1, Date.now() + DAY);

		const window = eventWindow(db);

		expect(window).toEqual({ oldest: 2, last: 1 });
		expect(canReplayFrom(window, 1)).toBe(true);
		expect(canReplayFrom(window, 0)).toBe(false);
	});
});
