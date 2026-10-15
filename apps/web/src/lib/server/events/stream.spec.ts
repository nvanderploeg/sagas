import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedProject, seedTicket } from '#lib/server/test/fixtures.ts';
import { subscriberCount } from './bus.ts';
import { eventsSince, pruneEvents } from './log.ts';
import { openEventStream, parseSince, SinceError } from './stream.ts';

let db: Db;
let readers: ReadableStreamDefaultReader<Uint8Array>[];

beforeEach(() => {
	db = testDb();
	readers = [];
});

afterEach(async () => {
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

function open(options: { since?: number; heartbeatMs?: number; maxBacklog?: number } = {}) {
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

const events = (frames: Frame[]) => frames.filter((f) => f.event !== undefined);
const ids = (frames: Frame[]) => events(frames).map((f) => Number(f.id));
const countAtLeast = (n: number) => (frames: Frame[]) => events(frames).length >= n;

describe('openEventStream', () => {
	it('opens with a comment and then streams live Events only', async () => {
		const project = seedProject(db, 'AM');
		const stream = open();

		const opened = await stream.until((frames) => frames.length >= 1);
		seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(1));

		expect(opened[0]).toEqual({ comment: 'ok' });
		const [ticket] = events(frames);
		const stored = eventsSince(db, 0).at(-1)!;
		expect(ticket).toMatchObject({ id: String(stored.seq), event: 'ticket.created' });
		expect(JSON.parse(ticket.data!)).toEqual(JSON.parse(JSON.stringify(stored)));
		expect(JSON.parse(ticket.data!).snapshot.key).toBe('AM-1');
	});

	it('replays every Event after the given seq, then goes live without a gap or a repeat', async () => {
		const project = seedProject(db, 'AM');
		const first = seedTicket(db, { projectId: project.id });
		seedTicket(db, { projectId: project.id });
		const since = eventsSince(db, 0).find((e) => e.entityIds.ticketId === first.id)!.seq;

		const stream = open({ since });
		await stream.until(countAtLeast(1));
		seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(2));

		expect(ids(frames)).toEqual([since + 1, since + 2]);
	});

	it('replays the whole log from zero', async () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });

		const frames = await open({ since: 0 }).until(countAtLeast(2));

		expect(ids(frames)).toEqual(eventsSince(db, 0).map((e) => e.seq));
	});

	it('sends reset, and no replay, when the seq is older than the oldest retained Event', async () => {
		const project = seedProject(db, 'AM');
		seedTicket(db, { projectId: project.id });
		const last = eventsSince(db, 0).at(-1)!.seq;
		pruneEvents(db, 1, Date.now() + 1000);

		const stream = open({ since: 0 });
		const reset = await stream.until(countAtLeast(1));
		seedTicket(db, { projectId: project.id });
		const frames = await stream.until(countAtLeast(2));

		expect(events(reset)).toEqual([
			{ id: String(last), event: 'reset', data: JSON.stringify({ seq: last }) }
		]);
		expect(events(frames)[1]).toMatchObject({ id: String(last + 1), event: 'ticket.created' });
	});

	it('sends reset when the seq is newer than any Event this server has assigned', async () => {
		seedProject(db, 'AM');

		const frames = await open({ since: 50 }).until(countAtLeast(1));

		expect(events(frames)).toEqual([{ id: '1', event: 'reset', data: '{"seq":1}' }]);
	});

	it('sends a heartbeat comment periodically', async () => {
		const frames = await open({ heartbeatMs: 10 }).until(
			(f) => f.filter((x) => x.comment === 'ping').length >= 2
		);

		expect(frames.filter((f) => f.comment === 'ping').length).toBeGreaterThanOrEqual(2);
	});

	it('unsubscribes when the client goes away', async () => {
		const before = subscriberCount();
		const stream = open();
		await stream.until((frames) => frames.length >= 1);
		expect(subscriberCount()).toBe(before + 1);

		await stream.reader.cancel();

		expect(subscriberCount()).toBe(before);
	});

	it('ends the stream of a client too far behind, so it reconnects and replays', async () => {
		const project = seedProject(db, 'AM');
		const before = subscriberCount();
		const stream = open({ maxBacklog: 2 });

		for (let i = 0; i < 5; i++) seedTicket(db, { projectId: project.id });
		await stream.until(() => false, 100);

		expect(stream.isDone()).toBe(true);
		expect(subscriberCount()).toBe(before);
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
