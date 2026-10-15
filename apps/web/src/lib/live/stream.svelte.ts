import { signInPath } from '../ui/return-path.ts';
import { FeedCore, type Feed, type Sink } from './core.ts';
import { EVENT_TYPES, type LiveEvent } from './types.ts';

export type Connection = 'idle' | 'connecting' | 'live' | 'retrying';

const MAX_RETRY_MS = 30_000;

// EventSource hides why it gave up; the Stream answers 401 once the session is gone.
async function refused(): Promise<boolean> {
	const abort = new AbortController();
	try {
		const response = await fetch('/api/events', { signal: abort.signal, cache: 'no-store' });
		return response.status === 401;
	} catch {
		return false;
	} finally {
		abort.abort();
	}
}

// The tab's one Stream. EventSource resumes with Last-Event-ID by itself; when it gives up for
// good (an error status), reopen with ?since= the last seq received.
class Stream implements Feed {
	status = $state<Connection>('idle');
	#core = new FeedCore();
	#source: EventSource | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#attempt = 0;
	#sinks = 0;
	#checking = false;

	attach(sink: Sink, since: number): () => void {
		if (!this.#core.started) this.#core.start(since);
		const detach = this.#core.attach(sink, since);
		this.#sinks += 1;
		if (this.#source === null && this.#retry === null && !this.#checking) this.#open();
		return () => {
			detach();
			this.#sinks -= 1;
		};
	}

	replay(sink: Sink, since: number): void {
		this.#core.replay(sink, since);
	}

	#open(): void {
		const since = this.#core.last ?? 0;
		const source = new EventSource(`/api/events?since=${since}`);
		this.#source = source;
		this.status = 'connecting';
		const onEvent = (message: MessageEvent<string>) =>
			this.#core.push(JSON.parse(message.data) as LiveEvent, message.data.length);
		for (const type of EVENT_TYPES) source.addEventListener(type, onEvent);
		source.addEventListener('ready', () => {
			this.status = 'live';
			this.#attempt = 0;
		});
		source.addEventListener('reset', (message: MessageEvent<string>) => {
			this.#core.reset((JSON.parse(message.data) as { seq: number }).seq);
		});
		source.onerror = () => {
			if (source.readyState !== EventSource.CLOSED) {
				this.status = 'retrying';
				return;
			}
			source.close();
			this.#source = null;
			if (this.#sinks === 0) {
				this.status = 'idle';
				return;
			}
			this.status = 'retrying';
			this.#checking = true;
			void refused().then((signedOut) => {
				this.#checking = false;
				if (signedOut) {
					this.status = 'idle';
					location.assign(signInPath(`${location.pathname}${location.search}${location.hash}`));
					return;
				}
				this.#schedule();
			});
		};
	}

	#schedule(): void {
		const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.#attempt);
		this.#attempt += 1;
		this.#retry = setTimeout(() => {
			this.#retry = null;
			this.#open();
		}, delay);
	}
}

export const stream = new Stream();
