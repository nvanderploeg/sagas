import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedRealm, seedLabour } from '#lib/server/test/fixtures.ts';
import { canReplayFrom, eventsSince, eventWindow, pruneEvents } from './log.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

const DAY = 24 * 60 * 60 * 1000;

async function age(seq: number, ms: number): Promise<void> {
	await db.$client.query('UPDATE sagas_events SET created_at = $1 WHERE seq = $2', [
		Date.now() - ms,
		seq
	]);
}

describe('pruneEvents', () => {
	it('drops only Events older than the retention window', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		const [first, second] = await eventsSince(db, 0);
		await age(first.seq, 8 * DAY);
		await age(second.seq, 6 * DAY);

		expect(await pruneEvents(db, 7 * DAY)).toBe(1);

		expect((await eventsSince(db, 0)).map((e) => e.seq)).toEqual([second.seq]);
	});

	it('keeps a contiguous seq range when timestamps run out of seq order', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id });
		const [first, second, third] = await eventsSince(db, 0);
		await age(first.seq, 6 * DAY);
		await age(second.seq, 8 * DAY);
		await age(third.seq, 6 * DAY);

		await pruneEvents(db, 7 * DAY);

		expect((await eventsSince(db, 0)).map((e) => e.seq)).toEqual([third.seq]);
		expect(canReplayFrom(await eventWindow(db), first.seq)).toBe(false);
	});

	it('never reuses a seq after pruning empties the log', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		const last = (await eventsSince(db, 0)).at(-1)!.seq;

		await pruneEvents(db, 1, Date.now() + DAY);
		expect(await db.select().from(events)).toEqual([]);
		await seedLabour(db, { realmId: realm.id });

		expect((await eventsSince(db, 0)).map((e) => e.seq)).toEqual([last + 1]);
	});
});

describe('eventWindow', () => {
	it('starts empty, replayable from zero', async () => {
		const window = await eventWindow(db);

		expect(window).toEqual({ oldest: 1, last: 0 });
		expect(canReplayFrom(window, 0)).toBe(true);
	});

	it('refuses a seq whose successors were pruned, and a seq never assigned', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id });
		const [first] = await eventsSince(db, 0);
		await age(first.seq, 8 * DAY);
		await pruneEvents(db, 7 * DAY);

		const window = await eventWindow(db);

		expect(window).toEqual({ oldest: first.seq + 1, last: first.seq + 2 });
		expect(canReplayFrom(window, first.seq - 1)).toBe(false);
		expect(canReplayFrom(window, first.seq)).toBe(true);
		expect(canReplayFrom(window, first.seq + 2)).toBe(true);
		expect(canReplayFrom(window, first.seq + 3)).toBe(false);
	});

	it('keeps the last seq once pruning empties the log', async () => {
		await seedRealm(db, 'AM');
		await pruneEvents(db, 1, Date.now() + DAY);

		const window = await eventWindow(db);

		expect(window).toEqual({ oldest: 2, last: 1 });
		expect(canReplayFrom(window, 1)).toBe(true);
		expect(canReplayFrom(window, 0)).toBe(false);
	});
});
