import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket } from '#lib/server/test/fixtures.ts';
import { subscribe, subscriberCount } from './bus.ts';
import { eventsSince, eventWindow, pruneEvents } from './log.ts';
import { openEventStream, parseSince, SinceError, type StreamOptions } from './stream.ts';

let db: Db;
let readers: ReadableStreamDefaultReader<Uint8Array>[];

beforeEach(() => {
	db = testDb();
	readers = [];
});

afterEach(async () => {
	vi.useRealTimers();
	for (const reader of readers) await reader.cancel();
	db.$client.close();
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
const lastSeq = () => eventWindow(db).last;

describe('openEventStream', () => {
	it('opens with ready carrying the last seq, then streams live Events only', async () => {
		const project = seedProject(db, 'AM');
		const stream = open();

		const opened = await stream.until(ready);
		seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(1));

		expect(opened).toEqual([control('ready', 1)]);
		const [ticket] = events(frames);
		const stored = eventsSince(db, 0).at(-1)!;
		expect(ticket).toMatchObject({ id: String(stored.seq), event: 'ticket.created' });
		expect(JSON.parse(ticket.data!)).toEqual(JSON.parse(JSON.stringify(stored)));
	});

	it('replays every Event after the given seq, sends ready, then goes live without a gap', async () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });
		const since = 2;

		const stream = open({ since });
		const opened = await stream.until(ready);
		seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(2));

		expect(opened.map((f) => f.event)).toEqual(['ticket.created', 'ready']);
		expect(opened.at(-1)).toEqual(control('ready', 3));
		expect(ids(frames)).toEqual([3, 4]);
	});

	it('replays the whole log from zero', async () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });

		const frames = await open({ since: 0 }).until(ready);

		expect(ids(frames)).toEqual(eventsSince(db, 0).map((e) => e.seq));
	});

	it('sends reset, and no replay, when the seq is older than the oldest retained Event', async () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		const last = lastSeq();
		pruneEvents(db, 1, Date.now() + 1000);

		const stream = open({ since: 0 });
		const opened = await stream.until(ready);
		seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(1));

		expect(opened).toEqual([control('reset', last), control('ready', last)]);
		expect(events(frames)).toMatchObject([{ id: String(last + 1), event: 'ticket.created' }]);
	});

	it('sends reset when the seq is newer than any Event this server has assigned', async () => {
		seedProject(db, 'AM');

		const frames = await open({ since: 50 }).until(ready);

		expect(frames).toEqual([control('reset', 1), control('ready', 1)]);
	});

	it('sends reset instead of a replay larger than the backlog cap', async () => {
		const project = seedProject(db, 'AM');
		for (let i = 0; i < 10; i++) seedTicket(db, { projectId: project.id });

		const frames = await open({ since: 0, maxBacklogBytes: 2048 }).until(ready);

		expect(frames).toEqual([control('reset', lastSeq()), control('ready', lastSeq())]);
	});

	it('sends an Event once when it is both replayed and published live', async () => {
		const project = seedProject(db, 'AM');
		let stream: ReturnType<typeof open> | undefined;
		const stop = subscribe((event) => {
			if (stream) return;
			seedTicket(db, { projectId: project.id });
			stream = open({ since: event.seq });
		});
		seedTicket(db, { projectId: project.id });
		stop();
		const first = lastSeq();

		await stream!.until(ready);
		seedTicket(db, { projectId: project.id });
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
		const project = seedProject(db, 'AM');
		const stream = open({ maxBacklogBytes: 2048 });

		for (let i = 0; i < 10; i++) seedTicket(db, { projectId: project.id });
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
	});

	it('keeps open a stream whose backlog of many Events stays within the cap', async () => {
		const project = seedProject(db, 'AM');
		const stream = open({ maxBacklogBytes: 64 * 1024 });

		for (let i = 0; i < 20; i++) seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(20));

		expect(stream.isDone()).toBe(false);
		expect(ids(frames)).toHaveLength(20);
	});
});

describe('stream lifetime', () => {
	function leftovers(before: number) {
		return { subscribers: subscriberCount() - before, timers: vi.getTimerCount() };
	}

	it('releases its subscription and timer when the client goes away', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const before = subscriberCount();
		const stream = open();
		await stream.until(ready);
		expect(leftovers(before)).toEqual({ subscribers: 1, timers: 1 });

		await stream.reader.cancel();

		expect(leftovers(before)).toEqual({ subscribers: 0, timers: 0 });
	});

	it('releases its subscription and timer when the backlog overflows', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const project = seedProject(db, 'AM');
		const before = subscriberCount();
		const stream = open({ maxBacklogBytes: 2048 });

		for (let i = 0; i < 10; i++) seedTicket(db, { projectId: project.id });
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
		expect(leftovers(before)).toEqual({ subscribers: 0, timers: 0 });
	});

	it('leaves no subscription or timer behind when it ends while opening', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const project = seedProject(db, 'AM');
		for (let i = 0; i < 6; i++) seedTicket(db, { projectId: project.id });
		const before = subscriberCount();

		const stream = open({ since: 0, maxBacklogBytes: 1 });
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
		expect(leftovers(before)).toEqual({ subscribers: 0, timers: 0 });
	});
});

describe('parseSince', () => {
	const request = (headers: Record<string, string> = {}) =>
		new Request('http://workload.test/api/events', { headers });

	it('prefers Last-Event-ID over ?since', () => {
		const url = new URL('http://workload.test/api/events?since=3');

		expect(parseSince(request({ 'last-event-id': '7' }), url)).toBe(7);
		expect(parseSince(request(), url)).toBe(3);
		expect(parseSince(request(), new URL('http://workload.test/api/events'))).toBeUndefined();
	});

	it('rejects a seq that is not a non-negative integer', () => {
		const url = new URL('http://workload.test/api/events?since=-1');

		expect(() => parseSince(request(), url)).toThrow(SinceError);
		expect(() => parseSince(request({ 'last-event-id': 'abc' }), url)).toThrow(SinceError);
	});
});
