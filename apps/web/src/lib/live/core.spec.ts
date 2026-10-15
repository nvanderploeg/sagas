import { describe, expect, it } from 'vitest';
import { FeedCore, LiveCore } from './core.ts';
import type { LiveEvent } from './types.ts';

type View = { title: string; seen: number[] };

const actor = { id: 1, kind: 'human' as const, username: 'ada', displayName: 'Ada' };

// A stand-in Event: the views below only read its seq and a title.
function event(seq: number, title = `t${seq}`): LiveEvent {
	return {
		seq,
		type: 'quest.deleted',
		actor,
		createdAt: new Date(0).toISOString(),
		data: { id: 0, title } as never
	};
}

const apply = (view: View, e: LiveEvent): View => ({
	title: (e.data as unknown as { title: string }).title,
	seen: [...view.seen, e.seq]
});

function live(seq: number, value: View = { title: 'loaded', seen: [] }) {
	const reloads: number[] = [];
	const core = new LiveCore<View>({ seq, value, apply, onReload: () => reloads.push(seq) });
	return { core, reloads };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('LiveCore', () => {
	it('drops Events at or below its load seq and applies each later one once', () => {
		const { core } = live(5);
		for (const seq of [3, 5, 6, 6, 7, 4]) core.receive(event(seq));
		expect(core.value?.seen).toEqual([6, 7]);
	});

	it('shows an optimistic patch at once and drops it when its own Event lands first', async () => {
		const { core } = live(10);
		const write = deferred<{ seq: number }>();
		const done = core.mutate(
			(v) => ({ ...v, title: 'mine' }),
			() => write.promise
		);
		expect(core.value?.title).toBe('mine');

		core.receive(event(11, 'mine'));
		expect(core.value).toEqual({ title: 'mine', seen: [11] });

		write.resolve({ seq: 11 });
		await done;
		expect(core.value).toEqual({ title: 'mine', seen: [11] });
		expect(core.value).toBe(core.confirmed);
	});

	it('keeps the patch over Events before its own until the view reaches the write seq', async () => {
		const { core } = live(10);
		await core.mutate(
			(v) => ({ ...v, title: 'mine' }),
			async () => ({ seq: 12 })
		);
		core.receive(event(11, 'theirs'));
		expect(core.value?.title).toBe('mine');
		expect(core.value?.seen).toEqual([11]);

		core.receive(event(12, 'mine'));
		expect(core.value).toBe(core.confirmed);
		expect(core.value?.title).toBe('mine');
	});

	it('rolls a failed write back', async () => {
		const { core } = live(10);
		await expect(
			core.mutate(
				(v) => ({ ...v, title: 'mine' }),
				async () => {
					throw new Error('refused');
				}
			)
		).rejects.toThrow('refused');
		expect(core.value?.title).toBe('loaded');
	});

	it('drops a patch at once when the view already holds its write seq', async () => {
		const { core } = live(10);
		core.receive(event(11, 'mine'));
		await core.mutate(
			(v) => ({ ...v, title: 'patched' }),
			async () => ({ seq: 11 })
		);
		expect(core.value?.title).toBe('mine');
	});

	it('takes a reload and replays only the Feed Events after its seq', () => {
		const feed = new FeedCore();
		feed.start(0);
		const { core } = live(0);
		core.connect(feed);
		for (const seq of [1, 2, 3, 4]) feed.push(event(seq));

		core.load({ title: 'reloaded', seen: [] }, 2);
		expect(core.value).toEqual({ title: 't4', seen: [3, 4] });
	});
});

describe('FeedCore', () => {
	it('replays its buffer to a view attaching at an earlier seq', () => {
		const feed = new FeedCore();
		feed.start(10);
		feed.push(event(11));
		feed.push(event(12));
		const { core } = live(11);
		core.connect(feed);
		expect(core.value?.seen).toEqual([12]);
	});

	it('asks a view older than its buffer to reload', () => {
		const feed = new FeedCore(2);
		feed.start(10);
		for (const seq of [11, 12, 13]) feed.push(event(seq));
		const { core, reloads } = live(10);
		core.connect(feed);
		expect(reloads).toHaveLength(1);
		expect(core.value?.seen).toEqual([]);
	});

	it('on reset asks every view to reload and serves Events from the reset seq on', () => {
		const feed = new FeedCore();
		feed.start(10);
		const { core, reloads } = live(10);
		core.connect(feed);
		feed.reset(50);
		expect(reloads).toHaveLength(1);

		feed.push(event(51));
		core.load({ title: 'reloaded', seen: [] }, 50);
		expect(core.value).toEqual({ title: 't51', seen: [51] });
	});

	it('caps its buffer by size, and asks a view older than what it dropped to reload', () => {
		const feed = new FeedCore(2000, 100);
		feed.start(10);
		for (const seq of [11, 12, 13]) feed.push(event(seq), 40);

		const stale = live(10);
		stale.core.connect(feed);
		expect(stale.reloads).toHaveLength(1);

		const fresh = live(11);
		fresh.core.connect(feed);
		expect(fresh.reloads).toHaveLength(0);
		expect(fresh.core.value?.seen).toEqual([12, 13]);
	});

	it('measures an Event by its JSON when no size is given', () => {
		const feed = new FeedCore(2000, 200);
		feed.start(10);
		const big = event(11, 'x'.repeat(300));
		feed.push(big);
		feed.push(event(12));

		const { core, reloads } = live(10);
		core.connect(feed);
		expect(reloads).toHaveLength(1);
	});

	it('ignores a repeated seq', () => {
		const feed = new FeedCore();
		feed.start(0);
		const { core } = live(0);
		core.connect(feed);
		feed.push(event(1));
		feed.push(event(1));
		expect(core.value?.seen).toEqual([1]);
		expect(feed.last).toBe(1);
	});
});
