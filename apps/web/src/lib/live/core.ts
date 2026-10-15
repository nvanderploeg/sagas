import { RELOAD, type Apply } from './apply.ts';
import type { LiveEvent } from './types.ts';

// Resume rules are docs/events.md, "Resume rules".

export interface Sink {
	receive(event: LiveEvent): void;
	// The Stream cannot give this view every Event after its seq: load it again.
	reset(): void;
}

export interface Feed {
	attach(sink: Sink, since: number): () => void;
	replay(sink: Sink, since: number): void;
}

// One Stream's Events, buffered so a view loaded at an earlier seq can catch up without a gap.
export class FeedCore implements Feed {
	#sinks = new Set<Sink>();
	#buffer: LiveEvent[] = [];
	// Every Event after `#from` is in the buffer.
	#from: number | null = null;
	#last: number | null = null;

	constructor(private readonly limit = 2000) {}

	get started(): boolean {
		return this.#from !== null;
	}

	get last(): number | null {
		return this.#last;
	}

	start(since: number): void {
		this.#from = since;
		this.#last = since;
	}

	attach(sink: Sink, since: number): () => void {
		this.#sinks.add(sink);
		this.replay(sink, since);
		return () => this.#sinks.delete(sink);
	}

	replay(sink: Sink, since: number): void {
		if (this.#from === null) return;
		if (since < this.#from) {
			sink.reset();
			return;
		}
		for (const event of this.#buffer) if (event.seq > since) sink.receive(event);
	}

	push(event: LiveEvent): void {
		if (this.#last !== null && event.seq <= this.#last) return;
		this.#last = event.seq;
		this.#buffer.push(event);
		if (this.#buffer.length > this.limit) {
			const dropped = this.#buffer.splice(0, this.#buffer.length - this.limit);
			this.#from = dropped.at(-1)!.seq;
		}
		for (const sink of [...this.#sinks]) sink.receive(event);
	}

	reset(seq: number): void {
		this.#buffer = [];
		this.#from = seq;
		this.#last = seq;
		for (const sink of [...this.#sinks]) sink.reset();
	}
}

type Pending<T> = { apply: (view: T) => T; until: number | null };

export type LiveOptions<T> = {
	seq: number;
	value: T;
	apply: Apply<T>;
	onChange?: () => void;
	onReload?: () => void;
	// Called after an Event is applied to the confirmed view.
	onEvent?: (event: LiveEvent, before: T, after: T) => void;
};

// A view kept live from Events. Optimistic patches lie over the confirmed view until it holds
// the seq their write returned, so the write's own Events land once and never twice.
export class LiveCore<T> implements Sink {
	#base: T | null;
	#seq: number;
	#pending: Pending<T>[] = [];
	#cached: { value: T | null } | null = null;
	#options: LiveOptions<T>;
	#feed: Feed | null = null;

	constructor(options: LiveOptions<T>) {
		this.#options = options;
		this.#base = options.value;
		this.#seq = options.seq;
	}

	get seq(): number {
		return this.#seq;
	}

	get ended(): boolean {
		return this.#base === null;
	}

	get confirmed(): T | null {
		return this.#base;
	}

	get value(): T | null {
		if (this.#cached === null) {
			const base = this.#base;
			this.#cached = {
				value: base === null ? null : this.#pending.reduce<T>((view, p) => p.apply(view), base)
			};
		}
		return this.#cached.value;
	}

	connect(feed: Feed): () => void {
		this.#feed = feed;
		const detach = feed.attach(this, this.#seq);
		return () => {
			detach();
			if (this.#feed === feed) this.#feed = null;
		};
	}

	receive(event: LiveEvent): void {
		if (event.seq <= this.#seq) return;
		this.#seq = event.seq;
		const before = this.#base;
		if (before === null) return;
		const after = this.#options.apply(before, event);
		if (after === RELOAD) {
			this.#options.onReload?.();
			return;
		}
		this.#base = after;
		this.#settle();
		this.#changed();
		if (after !== null) this.#options.onEvent?.(event, before, after);
	}

	reset(): void {
		this.#options.onReload?.();
	}

	load(value: T, seq: number): void {
		this.#base = value;
		this.#seq = seq;
		this.#settle();
		this.#changed();
		this.#feed?.replay(this, seq);
	}

	async mutate<R extends { seq: number }>(
		patch: (view: T) => T,
		run: () => Promise<R>
	): Promise<R> {
		const entry: Pending<T> = { apply: patch, until: null };
		this.#pending = [...this.#pending, entry];
		this.#changed();
		try {
			const result = await run();
			entry.until = result.seq;
			return result;
		} catch (error) {
			this.#pending = this.#pending.filter((p) => p !== entry);
			throw error;
		} finally {
			this.#settle();
			this.#changed();
		}
	}

	#settle(): void {
		const kept = this.#pending.filter((p) => p.until === null || p.until > this.#seq);
		if (kept.length !== this.#pending.length) this.#pending = kept;
	}

	#changed(): void {
		this.#cached = null;
		this.#options.onChange?.();
	}
}
