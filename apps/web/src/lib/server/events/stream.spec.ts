import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	announceRevoked,
	apiTokenCredential,
	credentialGuard,
	sessionCredential,
	type Credential
} from '#lib/server/auth/credentials.ts';
import { fakeSessions } from '#lib/server/auth/fixtures.ts';
import { createApiToken, revokeApiToken } from '#lib/server/auth/tokens.ts';
import { findUser } from '#lib/server/auth/users.ts';
import { apiTokens } from '#lib/server/db/schema.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedRealm, seedLabour, seedUser } from '#lib/server/test/fixtures.ts';
import { subscribe, subscriberCount } from './bus.ts';
import { eventsSince, eventWindow, pruneEvents } from './log.ts';
import {
	openEventStream,
	parseSince,
	SinceError,
	type StreamGuard,
	type StreamOptions
} from './stream.ts';

let db: Db;
let readers: ReadableStreamDefaultReader<Uint8Array>[];

beforeEach(async () => {
	db = await testDb();
	readers = [];
});

afterEach(async () => {
	vi.useRealTimers();
	for (const reader of readers) await reader.cancel();
});

type Frame = { id?: string; event?: string; data?: string; comment?: string };

function parseFrames(text: string): Frame[] {
	return text
		.split('\n\n')
		.slice(0, -1)
		.map((block) => {
			const frame: Frame = {};
			for (const line of block.split('\n')) {
				if (line.startsWith(':')) frame.comment = line.slice(1).trim();
				else {
					const colon = line.indexOf(':');
					const field = line.slice(0, colon) as 'id' | 'event' | 'data';
					frame[field] = line.slice(colon + 1).replace(/^ /, '');
				}
			}
			return frame;
		});
}

function open(options: Partial<StreamOptions> = {}) {
	const reader = openEventStream(db, { heartbeatMs: 60_000, ...options }).getReader();
	readers.push(reader);
	const decoder = new TextDecoder();
	let text = '';
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
	let done = false;

	// Reads until `enough` holds or `ms` pass, and returns every frame so far.
	async function until(enough: (frames: Frame[]) => boolean, ms = 500): Promise<Frame[]> {
		const deadline = Date.now() + ms;
		while (!done && !enough(parseFrames(text)) && Date.now() < deadline) {
			pending ??= reader.read();
			const timeout = new Promise<'timeout'>((resolve) =>
				setTimeout(resolve, deadline - Date.now(), 'timeout')
			);
			const result = await Promise.race([pending, timeout]);
			if (result === 'timeout') break;
			pending = null;
			if (result.done) done = true;
			else text += decoder.decode(result.value, { stream: true });
		}
		return parseFrames(text);
	}

	return { until, reader, isDone: () => done };
}

const CONTROL = new Set(['ready', 'reset']);
const events = (frames: Frame[]) => frames.filter((f) => f.event && !CONTROL.has(f.event));
const ids = (frames: Frame[]) => events(frames).map((f) => Number(f.id));
const countAtLeast = (n: number) => (frames: Frame[]) => events(frames).length >= n;
const ready = (frames: Frame[]) => frames.some((f) => f.event === 'ready');
const control = (event: string, seq: number) => ({
	id: String(seq),
	event,
	data: JSON.stringify({ seq })
});
const lastSeq = async () => (await eventWindow(db)).last;

describe('openEventStream', () => {
	it('opens with ready carrying the last seq, then streams live Events only', async () => {
		const realm = await seedRealm(db, 'AM');
		const stream = open();

		const opened = await stream.until(ready);
		await seedLabour(db, { realmId: realm.id });
		const frames = await stream.until(countAtLeast(1));

		expect(opened).toEqual([control('ready', 1)]);
		const [labour] = events(frames);
		const stored = (await eventsSince(db, 0)).at(-1)!;
		expect(labour).toMatchObject({ id: String(stored.seq), event: 'labour.created' });
		expect(JSON.parse(labour.data!)).toEqual(JSON.parse(JSON.stringify(stored)));
	});

	it('replays every Event after the given seq, sends ready, then goes live without a gap', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		await seedLabour(db, { realmId: realm.id });
		const since = 2;

		const stream = open({ since });
		const opened = await stream.until(ready);
		await seedLabour(db, { realmId: realm.id });
		const frames = await stream.until(countAtLeast(2));

		expect(opened.map((f) => f.event)).toEqual(['labour.created', 'ready']);
		expect(opened.at(-1)).toEqual(control('ready', 3));
		expect(ids(frames)).toEqual([3, 4]);
	});

	it('replays the whole log from zero', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });

		const frames = await open({ since: 0 }).until(ready);

		expect(ids(frames)).toEqual((await eventsSince(db, 0)).map((e) => e.seq));
	});

	it('sends reset, and no replay, when the seq is older than the oldest retained Event', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		const last = await lastSeq();
		await pruneEvents(db, 1, Date.now() + 1000);

		const stream = open({ since: 0 });
		const opened = await stream.until(ready);
		await seedLabour(db, { realmId: realm.id });
		const frames = await stream.until(countAtLeast(1));

		expect(opened).toEqual([control('reset', last), control('ready', last)]);
		expect(events(frames)).toMatchObject([{ id: String(last + 1), event: 'labour.created' }]);
	});

	it('sends reset when the seq is newer than any Event this server has assigned', async () => {
		await seedRealm(db, 'AM');

		const frames = await open({ since: 50 }).until(ready);

		expect(frames).toEqual([control('reset', 1), control('ready', 1)]);
	});

	it('sends reset instead of a replay larger than the backlog cap', async () => {
		const realm = await seedRealm(db, 'AM');
		for (let i = 0; i < 10; i++) await seedLabour(db, { realmId: realm.id });

		const frames = await open({ since: 0, maxBacklogBytes: 2048 }).until(ready);

		expect(frames).toEqual([control('reset', await lastSeq()), control('ready', await lastSeq())]);
	});

	it('sends an Event once when it is both replayed and published live', async () => {
		const realm = await seedRealm(db, 'AM');
		let stream: ReturnType<typeof open> | undefined;
		const concurrent: Promise<unknown>[] = [];
		const stop = subscribe((event) => {
			if (stream) return;
			concurrent.push(seedLabour(db, { realmId: realm.id }));
			stream = open({ since: event.seq });
		});
		await seedLabour(db, { realmId: realm.id });
		stop();
		await Promise.all(concurrent);
		const first = await lastSeq();

		await stream!.until(ready);
		await seedLabour(db, { realmId: realm.id });
		const frames = await stream!.until(countAtLeast(2));

		expect(ids(frames)).toEqual([first, first + 1]);
	});

	it('sends a heartbeat comment periodically', async () => {
		const frames = await open({ heartbeatMs: 10 }).until(
			(f) => f.filter((x) => x.comment === 'ping').length >= 2
		);

		expect(frames.filter((f) => f.comment === 'ping').length).toBeGreaterThanOrEqual(2);
	});
});

describe('backlog cap', () => {
	it('ends a stream whose unread backlog exceeds the cap in bytes, so it reconnects and replays', async () => {
		const realm = await seedRealm(db, 'AM');
		const stream = open({ maxBacklogBytes: 2048 });

		for (let i = 0; i < 10; i++) await seedLabour(db, { realmId: realm.id });
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
	});

	it('keeps open a stream whose backlog of many Events stays within the cap', async () => {
		const realm = await seedRealm(db, 'AM');
		const stream = open({ maxBacklogBytes: 64 * 1024 });

		for (let i = 0; i < 20; i++) await seedLabour(db, { realmId: realm.id });
		const frames = await stream.until(countAtLeast(20));

		expect(stream.isDone()).toBe(false);
		expect(ids(frames)).toHaveLength(20);
	});
});

describe('stream lifetime', () => {
	let watching: number;
	const guard: StreamGuard = {
		valid: () => true,
		watch: () => {
			watching += 1;
			return () => (watching -= 1);
		}
	};
	let before: number;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		watching = 0;
		before = subscriberCount();
	});

	const held = () => ({
		subscriptions: subscriberCount() - before,
		timers: vi.getTimerCount(),
		watches: watching
	});
	const nothing = { subscriptions: 0, timers: 0, watches: 0 };

	it('releases everything it holds when the client goes away', async () => {
		const stream = open({ guard });
		await stream.until(ready);
		expect(held()).toEqual({ subscriptions: 1, timers: 1, watches: 1 });

		await stream.reader.cancel();

		expect(held()).toEqual(nothing);
	});

	it('releases everything it holds when the backlog overflows', async () => {
		const realm = await seedRealm(db, 'AM');
		const stream = open({ guard, maxBacklogBytes: 2048 });

		for (let i = 0; i < 10; i++) await seedLabour(db, { realmId: realm.id });
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
		expect(held()).toEqual(nothing);
	});

	it('releases everything when the opening read fails', async () => {
		await db.$client.end();
		const streams = [1, 2, 3].map(() =>
			openEventStream(db, { guard, since: 0, heartbeatMs: 60_000 })
		);

		const reads = await Promise.allSettled(streams.map((stream) => stream.getReader().read()));

		expect(reads.every((read) => read.status === 'rejected')).toBe(true);
		expect(held()).toEqual(nothing);
	});

	it('leaves nothing behind when it ends while opening', async () => {
		const realm = await seedRealm(db, 'AM');
		for (let i = 0; i < 6; i++) await seedLabour(db, { realmId: realm.id });

		const stream = open({ guard, since: 0, maxBacklogBytes: 1 });
		// Read nothing while it opens, so the backlog is what overflows.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await stream.until(() => false, 2000);

		expect(stream.isDone()).toBe(true);
		expect(held()).toEqual(nothing);
	});

	it('releases everything it holds when its credential is revoked', async () => {
		let revoke = () => {};
		const revocable: StreamGuard = {
			valid: () => true,
			watch: (revoked) => {
				revoke = revoked;
				return guard.watch(revoked);
			}
		};
		const stream = open({ guard: revocable });
		await stream.until(ready);

		revoke();
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
		expect(held()).toEqual(nothing);
	});
});

describe('a stream bound to a credential', () => {
	async function signedIn() {
		const user = (await findUser(db, await seedUser(db, 'ada')))!;
		const stream = (credential: Credential, heartbeatMs = 60_000) => {
			const opened = open({ guard: credentialGuard(db, credential), heartbeatMs });
			return opened.until(ready).then(() => opened);
		};
		return { user, stream };
	}

	it('ends as soon as its API token is revoked', async () => {
		const { user, stream } = await signedIn();
		const { id, token } = await createApiToken(db, user, user.id, 'cli');
		const other = await createApiToken(db, user, user.id, 'other');
		const open = await stream(apiTokenCredential(token));

		await revokeApiToken(db, user, other.id);
		await open.until(() => false, 50);
		expect(open.isDone()).toBe(false);

		await revokeApiToken(db, user, id);
		await open.until(() => false, 100);
		expect(open.isDone()).toBe(true);
	});

	it('ends as soon as its session is announced revoked', async () => {
		const sessions = fakeSessions();
		const { user, stream } = await signedIn();
		const token = await sessions.open(db, user);
		const open = await stream(sessionCredential(token));

		announceRevoked(sessionCredential(token));
		await open.until(() => false, 100);

		expect(open.isDone()).toBe(true);
		sessions.restore();
	});

	it('ends on the next heartbeat once Firebase no longer vouches for its session', async () => {
		const sessions = fakeSessions();
		const { user, stream } = await signedIn();
		const token = await sessions.open(db, user);
		const open = await stream(sessionCredential(token), 10);
		await open.until((f) => f.some((x) => x.comment === 'ping'));
		expect(open.isDone()).toBe(false);

		sessions.end(token);
		await open.until(() => false, 100);

		expect(open.isDone()).toBe(true);
		sessions.restore();
	});

	it('ends on the next heartbeat once its API token is no longer valid', async () => {
		const { user, stream } = await signedIn();
		const { token } = await createApiToken(db, user, user.id, 'cli');
		const open = await stream(apiTokenCredential(token), 10);

		await db.update(apiTokens).set({ revokedAt: new Date() });
		await open.until(() => false, 100);

		expect(open.isDone()).toBe(true);
	});
});

describe('parseSince', () => {
	const request = (headers: Record<string, string> = {}) =>
		new Request('http://sagas.test/api/events', { headers });

	it('prefers Last-Event-ID over ?since', () => {
		const url = new URL('http://sagas.test/api/events?since=3');

		expect(parseSince(request({ 'last-event-id': '7' }), url)).toBe(7);
		expect(parseSince(request(), url)).toBe(3);
		expect(parseSince(request(), new URL('http://sagas.test/api/events'))).toBeUndefined();
	});

	it('rejects a seq that is not a non-negative integer', () => {
		const url = new URL('http://sagas.test/api/events?since=-1');

		expect(() => parseSince(request(), url)).toThrow(SinceError);
		expect(() => parseSince(request({ 'last-event-id': 'abc' }), url)).toThrow(SinceError);
	});
});
