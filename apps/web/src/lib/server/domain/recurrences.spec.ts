import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { labours } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { eq } from 'drizzle-orm';
import { DomainError } from './errors.ts';
import { deleteLabour, updateLabour } from './labours.ts';
import { createQuest, readQuest } from './quests.ts';
import {
	createRecurrence,
	deleteRecurrence,
	readRecurrence,
	runRecurrences,
	updateRecurrence
} from './recurrences.ts';
import { listStates } from './states.ts';
import type { Actor } from './write.ts';

let db: Db;
let actor: Actor;
let ownerId: number;
let realmId: number;

const at = (iso: string) => new Date(iso);

// Finishing a Labour stamps it with the clock, so the clock follows the scenario.
const clock = (iso: string) => vi.setSystemTime(at(iso));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	clock('2026-01-01T09:00:00Z');
	db = testDb();
	actor = seedActor(db);
	ownerId = seedUser(db, 'ada');
	realmId = seedRealm(db).id;
});

afterEach(() => {
	vi.useRealTimers();
	db.$client.close();
});

function seedMonthly(
	startsOn = '2026-01-01',
	extra: Partial<Parameters<typeof createRecurrence>[2]> = {}
) {
	return createRecurrence(
		db,
		actor,
		{ realmId, title: 'Review chatbot errors', ownerId, unit: 'month', startsOn, ...extra },
		at('2026-01-01T09:00:00Z')
	);
}

function finish(labourId: number) {
	const closed = listStates(db, realmId).find((state) => state.isClosed)!;
	updateLabour(db, actor, labourId, { stateId: closed.id });
}

const labourCount = () => db.select().from(labours).all().length;

describe('createRecurrence', () => {
	it('creates the first Labour at once when the start date has come', () => {
		const recurrence = seedMonthly();
		expect(labourCount()).toBe(1);
		const labour = db.select().from(labours).get()!;
		expect(labour).toMatchObject({ title: 'Review chatbot errors', recurrenceId: recurrence.id });
		expect(readRecurrence(db, recurrence.id)).toMatchObject({
			labourId: labour.id,
			nextDueAt: null
		});
	});

	it('waits for a start date in the future', () => {
		const recurrence = seedMonthly('2026-02-01');
		expect(labourCount()).toBe(0);
		expect(recurrence.nextDueAt).toEqual(at('2026-02-01T00:00:00Z'));
		expect(runRecurrences(db, at('2026-01-31T23:59:00Z'))).toEqual([]);
		expect(runRecurrences(db, at('2026-02-01T00:00:00Z'))).toHaveLength(1);
	});

	it('adds each new Labour to its Quests', () => {
		const quest = createQuest(db, actor, { realmId, name: 'Upkeep', ownerId });
		const recurrence = seedMonthly('2026-01-01', { questIds: [quest.id] });
		expect(readQuest(db, quest.id).labours.map((l) => l.id)).toEqual([recurrence.labourId]);
		finish(recurrence.labourId!);
		runRecurrences(db, at('2026-02-01T00:00:00Z'));
		expect(readQuest(db, quest.id).labours).toHaveLength(2);
	});

	it('rejects a bad cadence, date or zone', () => {
		const spec = { realmId, title: 'x', ownerId, unit: 'month' } as const;
		for (const bad of [{ every: 0 }, { startsOn: '2026-13-01' }, { timezone: 'Nowhere/Land' }]) {
			expect(() => createRecurrence(db, actor, { ...spec, ...bad })).toThrow(DomainError);
		}
	});
});

describe('runRecurrences', () => {
	it('creates the next Labour at the next occurrence after the last was finished', () => {
		const recurrence = seedMonthly();
		clock('2026-01-20T00:00:00Z');
		finish(recurrence.labourId!);
		expect(runRecurrences(db, at('2026-01-20T00:00:00Z'))).toEqual([]);
		expect(readRecurrence(db, recurrence.id).nextDueAt).toEqual(at('2026-02-01T00:00:00Z'));
		expect(runRecurrences(db, at('2026-02-01T00:00:00Z'))).toHaveLength(1);
		expect(labourCount()).toBe(2);
	});

	it('creates nothing while the last Labour is unfinished', () => {
		seedMonthly();
		expect(runRecurrences(db, at('2026-06-01T00:00:00Z'))).toEqual([]);
		expect(labourCount()).toBe(1);
	});

	it('schedules from when the Labour was finished, skipping occurrences missed while it was open', () => {
		const recurrence = seedMonthly();
		clock('2026-05-09T00:00:00Z');
		finish(recurrence.labourId!);
		expect(runRecurrences(db, at('2026-05-10T00:00:00Z'))).toEqual([]);
		expect(readRecurrence(db, recurrence.id).nextDueAt).toEqual(at('2026-06-01T00:00:00Z'));
		expect(runRecurrences(db, at('2026-06-01T00:00:00Z'))).toHaveLength(1);
		expect(labourCount()).toBe(2);
	});

	it('does not create a Labour twice for one occurrence', () => {
		const recurrence = seedMonthly();
		finish(recurrence.labourId!);
		runRecurrences(db, at('2026-02-01T00:00:00Z'));
		runRecurrences(db, at('2026-02-01T00:01:00Z'));
		expect(labourCount()).toBe(2);
	});

	it('counts a deleted Labour as finished', () => {
		const recurrence = seedMonthly();
		deleteLabour(db, actor, recurrence.labourId!);
		expect(runRecurrences(db, at('2026-01-01T10:00:00Z'))).toEqual([]);
		expect(readRecurrence(db, recurrence.id).nextDueAt).toEqual(at('2026-02-01T00:00:00Z'));
	});

	it('does nothing while paused', () => {
		const recurrence = seedMonthly();
		finish(recurrence.labourId!);
		updateRecurrence(db, actor, recurrence.id, { paused: true }, at('2026-01-02T00:00:00Z'));
		expect(runRecurrences(db, at('2026-03-01T00:00:00Z'))).toEqual([]);
		updateRecurrence(db, actor, recurrence.id, { paused: false }, at('2026-03-01T00:00:00Z'));
		expect(labourCount()).toBe(2);
	});
});

describe('updateRecurrence', () => {
	it('applies new text to the next Labour only', () => {
		const recurrence = seedMonthly();
		finish(recurrence.labourId!);
		updateRecurrence(
			db,
			actor,
			recurrence.id,
			{ title: 'Review logs' },
			at('2026-01-02T00:00:00Z')
		);
		runRecurrences(db, at('2026-02-01T00:00:00Z'));
		const titles = db.select({ title: labours.title }).from(labours).orderBy(labours.id).all();
		expect(titles.map((row) => row.title)).toEqual(['Review chatbot errors', 'Review logs']);
	});

	it('reschedules a waiting Recurrence when the cadence changes', () => {
		const recurrence = seedMonthly();
		finish(recurrence.labourId!);
		runRecurrences(db, at('2026-01-02T00:00:00Z'));
		const weekly = updateRecurrence(
			db,
			actor,
			recurrence.id,
			{ unit: 'week', startsOn: '2026-01-05' },
			at('2026-01-02T00:00:00Z')
		);
		expect(weekly.nextDueAt).toEqual(at('2026-01-05T00:00:00Z'));
	});
});

describe('deleteRecurrence', () => {
	it('keeps the Labours it created', () => {
		const recurrence = seedMonthly();
		deleteRecurrence(db, actor, recurrence.id);
		const labour = db
			.select()
			.from(labours)
			.where(eq(labours.title, 'Review chatbot errors'))
			.get();
		expect(labour?.recurrenceId).toBeNull();
		expect(() => readRecurrence(db, recurrence.id)).toThrow(DomainError);
	});
});
