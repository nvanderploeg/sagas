import type { Handle } from '../db/client.ts';
import { subscribe } from './bus.ts';
import { canReplayFrom, eventsSince, eventWindow } from './log.ts';
import type { WorkloadEvent } from './types.ts';

export type StreamOptions = {
	since?: number;
	heartbeatMs: number;
	maxBacklog?: number;
};

export const STREAM_HEADERS = {
	'content-type': 'text/event-stream',
	'cache-control': 'no-cache, no-transform',
	'x-accel-buffering': 'no'
};

const encoder = new TextEncoder();

export class SinceError extends Error {}

// Last-Event-ID wins over ?since, as an EventSource reconnect sends the header.
export function parseSince(request: Request, url: URL): number | undefined {
	const raw = request.headers.get('last-event-id') || url.searchParams.get('since');
	if (!raw) return undefined;
	if (!/^\d+$/.test(raw.trim())) throw new SinceError('since must be a non-negative integer');
	return Number(raw.trim());
}

export function eventFrame(event: WorkloadEvent): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function resetFrame(seq: number): string {
	return `id: ${seq}\nevent: reset\ndata: ${JSON.stringify({ seq })}\n\n`;
}

export function openEventStream(db: Handle, options: StreamOptions): ReadableStream<Uint8Array> {
	const maxBacklog = options.maxBacklog ?? 1000;
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let lastSeq = 0;
	let unsubscribe: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	function cleanup(): void {
		closed = true;
		unsubscribe?.();
		unsubscribe = undefined;
		clearInterval(heartbeat);
	}

	function send(text: string): void {
		if (closed) return;
		// A client this far behind reconnects and replays instead of holding server memory.
		if ((controller.desiredSize ?? 0) < -maxBacklog) {
			cleanup();
			controller.close();
			return;
		}
		try {
			controller.enqueue(encoder.encode(text));
		} catch {
			cleanup();
		}
	}

	function emit(event: WorkloadEvent): void {
		if (event.seq <= lastSeq) return;
		lastSeq = event.seq;
		send(eventFrame(event));
	}

	return new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			send(': ok\n\n');
			// Read the log and subscribe in one synchronous turn: no write can commit between them.
			const window = eventWindow(db);
			lastSeq = window.last;
			if (options.since !== undefined) {
				if (canReplayFrom(window, options.since)) {
					lastSeq = options.since;
					for (const event of eventsSince(db, options.since)) emit(event);
				} else {
					send(resetFrame(window.last));
				}
			}
			unsubscribe = subscribe(emit);
			heartbeat = setInterval(() => send(': ping\n\n'), options.heartbeatMs);
		},
		cancel() {
			cleanup();
		}
	});
}
