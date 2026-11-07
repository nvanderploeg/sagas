import type { Db } from '../db/client.ts';
import { subscribe } from './bus.ts';
import { eventForViewer } from './visibility.ts';
import { canReplayFrom, eventsSince, eventWindow } from './log.ts';
import type { SagasEvent } from './types.ts';
import { readSnapshot } from '#lib/server/db/tx.ts';

export const DEFAULT_MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

// Who may keep a stream open: `valid` is checked on every heartbeat, `watch` calls back on revocation
// and returns its own release.
export type StreamGuard = {
	valid(): boolean | Promise<boolean>;
	watch(revoked: () => void): () => void;
};

export type StreamOptions = {
	since?: number;
	heartbeatMs: number;
	maxBacklogBytes?: number;
	guard?: StreamGuard;
	// Deliver only what this User may see; an Event they may not see still advances the stream's seq.
	viewer?: { id: number };
};

export const STREAM_HEADERS = {
	'content-type': 'text/event-stream',
	'cache-control': 'no-cache, no-transform',
	'x-accel-buffering': 'no'
};

const encoder = new TextEncoder();
const PING = encoder.encode(': ping\n\n');
const REPLAY_PAGE = 200;

const openStreams = new Set<() => void>();

// Closes every open Stream; each client reconnects and resumes or resets.
export function endEventStreams(): void {
	for (const close of [...openStreams]) close();
}

const report = (error: unknown) => console.error('sagas event stream failed', error);

export class SinceError extends Error {}

// Last-Event-ID wins over ?since, as an EventSource reconnect sends the header.
export function parseSince(request: Request, url: URL): number | undefined {
	const raw = request.headers.get('last-event-id') || url.searchParams.get('since');
	if (!raw) return undefined;
	if (!/^\d+$/.test(raw.trim())) throw new SinceError('since must be a non-negative integer');
	return Number(raw.trim());
}

export function eventFrame(event: SagasEvent): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function controlFrame(type: 'ready' | 'reset' | 'seq', seq: number): string {
	return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq })}\n\n`;
}

// A replay, or a reset when there is none to give, then ready: all read in one transaction.
async function openingFrames(
	db: Db,
	since: number | undefined,
	maxBytes: number,
	viewer: { id: number } | undefined
): Promise<{ frames: Uint8Array[]; seq: number }> {
	return readSnapshot(db, async (tx) => {
		const { oldest, last } = await eventWindow(tx);
		const ready = encoder.encode(controlFrame('ready', last));
		const reset = { frames: [encoder.encode(controlFrame('reset', last)), ready], seq: last };
		if (since === undefined) return { frames: [ready], seq: last };
		if (!canReplayFrom({ oldest, last }, since)) return reset;

		const frames: Uint8Array[] = [];
		let bytes = 0;
		for (let after = since; after < last;) {
			const page = await eventsSince(tx, after, REPLAY_PAGE);
			if (page.length === 0) break;
			for (const sent of page) {
				const event = viewer === undefined ? sent : await eventForViewer(tx, sent, viewer);
				if (event === null) continue;
				const frame = encoder.encode(eventFrame(event));
				bytes += frame.byteLength;
				if (bytes > maxBytes) return reset;
				frames.push(frame);
			}
			after = page[page.length - 1].seq;
		}
		frames.push(ready);
		return { frames, seq: last };
	});
}

export function openEventStream(db: Db, options: StreamOptions): ReadableStream<Uint8Array> {
	const maxBytes = options.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES;
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let open = true;
	let lastSeq = 0;
	const releases: (() => void)[] = [];

	// Take every subscription and timer through here, so none outlives the stream however it ends.
	function hold(release: () => void): void {
		if (open) releases.push(release);
		else release();
	}

	function release(): void {
		open = false;
		for (const stop of releases.splice(0)) stop();
	}

	function close(): void {
		if (!open) return;
		release();
		try {
			controller.close();
		} catch {
			// The consumer already cancelled.
		}
	}

	function send(chunk: Uint8Array): void {
		if (!open) return;
		// A client this far behind reconnects and replays instead of holding server memory.
		if (-(controller.desiredSize ?? 0) > maxBytes) return close();
		try {
			controller.enqueue(chunk);
		} catch {
			release();
		}
	}

	// Set while Events the viewer may not see have passed: their seq still has to reach the client.
	let unseen = false;

	async function emit(event: SagasEvent): Promise<void> {
		if (event.seq <= lastSeq) return;
		lastSeq = event.seq;
		const shown =
			options.viewer === undefined ? event : await eventForViewer(db, event, options.viewer);
		if (shown === null) {
			unseen = true;
			return;
		}
		send(encoder.encode(eventFrame(shown)));
	}

	async function heartbeat(): Promise<void> {
		if (options.guard && !(await options.guard.valid())) return close();
		if (unseen) {
			unseen = false;
			send(encoder.encode(controlFrame('seq', lastSeq)));
			return;
		}
		send(PING);
	}

	return new ReadableStream<Uint8Array>(
		{
			async start(c) {
				controller = c;
				if (options.guard) hold(options.guard.watch(close));
				openStreams.add(close);
				hold(() => openStreams.delete(close));
				// Subscribe before reading the log, and deliver after it: an Event that commits between
				// the two is either in the opening read or arrives behind it, in seq order.
				const opened = openingFrames(db, options.since, maxBytes, options.viewer);
				let tail: Promise<void> = opened.then(
					() => undefined,
					() => undefined
				);
				hold(
					subscribe((event) => {
						tail = tail.then(() => emit(event)).catch(report);
					})
				);
				const opening = await opened;
				lastSeq = opening.seq;
				for (const frame of opening.frames) send(frame);
				const timer = setInterval(() => void heartbeat().catch(report), options.heartbeatMs);
				hold(() => clearInterval(timer));
			},
			cancel() {
				release();
			}
		},
		{ highWaterMark: 0, size: (chunk) => chunk.byteLength }
	);
}
