import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labourVectors, labours } from '#lib/server/db/schema.ts';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { createLabour, deleteLabour, updateLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import {
	createEmbeddingQueue,
	enqueueStale,
	readVectors,
	setEmbeddingQueue,
	vectorStatus,
	writeVector
} from './index.ts';

const MODEL_ID = 'Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3';
const DIMENSIONS = 384;

type Embedder = {
	model: string;
	embedDocument(text: string): Promise<Float32Array>;
	embedQuery(text: string): Promise<Float32Array>;
};

type QueueLike = { enqueue(labourId: number): void; drain(): Promise<void>; size(): number };

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realmId = seedRealm(db, 'AM').id;
});

afterEach(() => {
	setEmbeddingQueue(null);
	vi.restoreAllMocks();
	db.$client.close();
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// A deterministic unit vector derived from a hash of the text.
function unitVector(text: string): Float32Array {
	let state = createHash('sha256').update(text).digest().readUInt32LE(0) || 1;
	const out = new Float32Array(DIMENSIONS);
	let norm = 0;
	for (let i = 0; i < DIMENSIONS; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const x = state / 2 ** 32 - 0.5;
		out[i] = x;
		norm += x * x;
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < DIMENSIONS; i++) out[i] /= norm;
	return out;
}

type FakeEmbedder = Embedder & {
	documents: string[];
	queries: string[];
	peak: number;
	fail: (text: string) => boolean;
};

// `gate` holds every embedding until it resolves; without one each embedding yields one tick.
function fakeEmbedder(options: { gate?: Promise<void>; fail?: (text: string) => boolean } = {}) {
	let inflight = 0;
	const embedder: FakeEmbedder = {
		model: MODEL_ID,
		documents: [],
		queries: [],
		peak: 0,
		fail: options.fail ?? (() => false),
		async embedDocument(text) {
			embedder.documents.push(text);
			inflight += 1;
			embedder.peak = Math.max(embedder.peak, inflight);
			try {
				await (options.gate ?? new Promise<void>((resolve) => setImmediate(resolve)));
				if (embedder.fail(text)) throw new Error(`cannot embed ${text}`);
				return unitVector(text);
			} finally {
				inflight -= 1;
			}
		},
		async embedQuery(text) {
			embedder.queries.push(text);
			return unitVector(text);
		}
	};
	return embedder;
}

// The embedding input of a Labour: title, Brief and description, trimmed, empties dropped.
const inputOf = (title: string, description = '', brief = '') =>
	[title, brief, description]
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.join('\n\n');

function labour(title = 'Labour', description = '') {
	return seedLabour(db, { realmId, title, description });
}

function embed(labourId: number, input: string, model = MODEL_ID) {
	writeVector(db, labourId, model, sha(input), unitVector(input));
}

function vectorRow(labourId: number) {
	return db.select().from(labourVectors).where(eq(labourVectors.labourId, labourId)).get();
}

function vectorRows() {
	return db.select().from(labourVectors).all();
}

function setDescription(labourId: number, description: string) {
	updateLabour(db, actor, labourId, { description });
}

function statusOf(labourId: number) {
	return vectorStatus(db, [labourId]).get(labourId);
}

// Records each enqueue, and whether it ran inside an open transaction.
function spyQueue() {
	const calls: { id: number; inTransaction: boolean }[] = [];
	const queue: QueueLike = {
		enqueue: (id) => calls.push({ id, inTransaction: db.$client.inTransaction }),
		drain: async () => {},
		size: () => 0
	};
	return { queue, calls, ids: () => calls.map((call) => call.id) };
}

function useRealQueue(embedder: Embedder = fakeEmbedder()) {
	const queue = createEmbeddingQueue(db, embedder);
	setEmbeddingQueue(queue);
	return { queue, embedder: embedder as FakeEmbedder };
}

describe('writeVector and readVectors', () => {
	it('stores 384 little-endian float32 values as a 1,536-byte blob and reads them back exactly', () => {
		const l = labour();
		const vector = unitVector('round trip');
		writeVector(db, l.id, MODEL_ID, sha(inputOf('Labour')), vector);

		const row = db.$client
			.prepare('SELECT vector FROM labour_vectors WHERE labour_id = ?')
			.get(l.id) as { vector: Buffer };
		expect(row.vector.byteLength).toBe(1536);
		const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
		for (let i = 0; i < DIMENSIONS; i++) {
			expect(view.getFloat32(i * 4, true)).toBe(vector[i]);
		}

		const read = readVectors(db, [l.id]).get(l.id)!;
		expect(read).toBeInstanceOf(Float32Array);
		expect(read.length).toBe(DIMENSIONS);
		expect(Array.from(read)).toEqual(Array.from(vector));
	});

	it('records the model, input hash and time it was given', () => {
		const l = labour();
		const hash = sha(inputOf('Labour'));
		const now = new Date('2026-03-04T05:06:07.000Z');

		writeVector(db, l.id, MODEL_ID, hash, unitVector('a'), now);

		const row = vectorRow(l.id)!;
		expect(row.model).toBe(MODEL_ID);
		expect(row.inputHash).toBe(hash);
		expect(row.embeddedAt.getTime()).toBe(now.getTime());
	});

	it('replaces the earlier vector of a Labour instead of adding a second row', () => {
		const l = labour();
		writeVector(db, l.id, 'older-model', sha('old'), unitVector('old'));

		const next = unitVector('new');
		writeVector(db, l.id, MODEL_ID, sha(inputOf('Labour')), next);

		expect(vectorRows()).toHaveLength(1);
		expect(vectorRow(l.id)!.model).toBe(MODEL_ID);
		expect(Array.from(readVectors(db, [l.id]).get(l.id)!)).toEqual(Array.from(next));
	});

	it('ignores a Labour that does not exist', () => {
		expect(() =>
			writeVector(db, 987_654, MODEL_ID, sha('ghost'), unitVector('ghost'))
		).not.toThrow();
		expect(vectorRows()).toHaveLength(0);
	});

	it('ignores a Labour that was deleted', () => {
		const l = labour();
		deleteLabour(db, actor, l.id);

		expect(() => writeVector(db, l.id, MODEL_ID, sha('x'), unitVector('x'))).not.toThrow();
		expect(vectorRows()).toHaveLength(0);
	});

	it('is removed with its Labour', () => {
		const kept = labour('Kept');
		const gone = labour('Gone');
		embed(kept.id, inputOf('Kept'));
		embed(gone.id, inputOf('Gone'));

		deleteLabour(db, actor, gone.id);

		expect(vectorRows().map((row) => row.labourId)).toEqual([kept.id]);
	});

	it('returns only current vectors', () => {
		const current = labour('Current', 'body');
		const staleText = labour('Stale text');
		const staleModel = labour('Stale model');
		const absent = labour('Absent');
		embed(current.id, inputOf('Current', 'body'));
		embed(staleText.id, inputOf('Something else'));
		embed(staleModel.id, inputOf('Stale model'), 'another-model@1');

		const read = readVectors(db, [current.id, staleText.id, staleModel.id, absent.id]);

		expect([...read.keys()]).toEqual([current.id]);
		expect(Array.from(read.get(current.id)!)).toEqual(Array.from(unitVector('Current\n\nbody')));
	});

	it('returns nothing for no ids', () => {
		expect(readVectors(db, []).size).toBe(0);
	});
});

describe('vectorStatus', () => {
	it('is current when model and input hash both match', () => {
		const l = labour('Title', 'Body');
		embed(l.id, inputOf('Title', 'Body'));

		expect(statusOf(l.id)).toBe('current');
	});

	it('is absent when the Labour has no vector', () => {
		expect(statusOf(labour().id)).toBe('absent');
	});

	it('is stale when the title changed after embedding', () => {
		const l = labour('Title', 'Body');
		embed(l.id, inputOf('Title', 'Body'));

		updateLabour(db, actor, l.id, { title: 'Another title' });

		expect(statusOf(l.id)).toBe('stale');
	});

	it('is stale when the description changed after embedding', () => {
		const l = labour('Title', 'Body');
		embed(l.id, inputOf('Title', 'Body'));

		updateLabour(db, actor, l.id, { description: 'Different body' });

		expect(statusOf(l.id)).toBe('stale');
	});

	it('is stale when a Brief was written after embedding', () => {
		const l = labour('Title', 'Body');
		embed(l.id, inputOf('Title', 'Body'));

		appraise(db, actor, [{ labourId: l.id, brief: 'A new Brief' }]);

		expect(statusOf(l.id)).toBe('stale');
	});

	it('is current when the vector was embedded with the Brief', () => {
		const l = labour('Title', 'Body');
		appraise(db, actor, [{ labourId: l.id, brief: '  A Brief  ' }]);

		embed(l.id, inputOf('Title', 'Body', 'A Brief'));

		expect(statusOf(l.id)).toBe('current');
	});

	it('stays current when only fields outside the embedding input change', () => {
		const l = labour('Title', 'Body');
		embed(l.id, inputOf('Title', 'Body'));

		updateLabour(db, actor, l.id, { labels: ['combat'], assigneeId: seedUser(db, 'grace') });

		expect(statusOf(l.id)).toBe('current');
	});

	it('is stale when the model differs even though the input hash matches', () => {
		const l = labour('Title', 'Body');
		embed(l.id, inputOf('Title', 'Body'), 'Xenova/bge-small-en-v1.5@0000000');

		expect(statusOf(l.id)).toBe('stale');
	});

	it('reports every requested Labour in one map', () => {
		const current = labour('One');
		const stale = labour('Two');
		const absent = labour('Three');
		embed(current.id, inputOf('One'));
		embed(stale.id, inputOf('Not two'));

		const status = vectorStatus(db, [current.id, stale.id, absent.id]);

		expect(status.size).toBe(3);
		expect(status.get(current.id)).toBe('current');
		expect(status.get(stale.id)).toBe('stale');
		expect(status.get(absent.id)).toBe('absent');
		expect(vectorStatus(db, []).size).toBe(0);
	});

	describe('embedding input', () => {
		it('is the title alone when the description is empty and there is no Brief', () => {
			const l = labour('Only a title', '');
			embed(l.id, 'Only a title');

			expect(statusOf(l.id)).toBe('current');
		});

		it('drops a whitespace-only description rather than joining an empty part', () => {
			const l = labour('Only a title');
			setDescription(l.id, ' \n\t ');
			embed(l.id, 'Only a title');

			expect(statusOf(l.id)).toBe('current');
		});

		it('trims the description', () => {
			const l = labour('Title');
			setDescription(l.id, '\n  Padded body  \n');
			embed(l.id, 'Title\n\nPadded body');

			expect(statusOf(l.id)).toBe('current');
		});

		it('joins title, Brief and description with a blank line, in that order', () => {
			const l = labour('Title', 'Body');
			appraise(db, actor, [{ labourId: l.id, brief: 'Brief' }]);
			embed(l.id, 'Title\n\nBrief\n\nBody');

			expect(statusOf(l.id)).toBe('current');
		});

		it('leaves out an empty Brief without a doubled separator', () => {
			const l = labour('Title', 'Body');
			appraise(db, actor, [{ labourId: l.id, brief: 'Brief' }]);
			appraise(db, actor, [{ labourId: l.id, brief: '' }]);
			embed(l.id, 'Title\n\nBody');

			expect(statusOf(l.id)).toBe('current');
		});

		it('hashes with SHA-256 over the input string', () => {
			const l = labour('Title', 'Body');
			writeVector(
				db,
				l.id,
				MODEL_ID,
				createHash('sha256').update('Title\n\nBody').digest('hex'),
				unitVector('v')
			);

			expect(statusOf(l.id)).toBe('current');
		});
	});
});

describe('the embedding queue', () => {
	it('embeds a queued Labour and stores its vector under the embedder model', async () => {
		const l = labour('Dragon', 'Fire');
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(l.id);
		await queue.drain();

		expect(embedder.documents).toEqual(['Dragon\n\nFire']);
		const row = vectorRow(l.id)!;
		expect(row.model).toBe(MODEL_ID);
		expect(row.inputHash).toBe(sha('Dragon\n\nFire'));
		expect(Array.from(readVectors(db, [l.id]).get(l.id)!)).toEqual(
			Array.from(unitVector('Dragon\n\nFire'))
		);
		expect(statusOf(l.id)).toBe('current');
	});

	it('embeds the Brief between the title and the description', async () => {
		const l = labour('Dragon', 'Fire');
		appraise(db, actor, [{ labourId: l.id, brief: ' Slay it ' }]);
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(l.id);
		await queue.drain();

		expect(embedder.documents).toEqual(['Dragon\n\nSlay it\n\nFire']);
		expect(vectorRow(l.id)!.inputHash).toBe(sha('Dragon\n\nSlay it\n\nFire'));
	});

	it('embeds a Labour queued twice once', async () => {
		const l = labour('Twice');
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(l.id);
		queue.enqueue(l.id);
		queue.enqueue(l.id);
		await queue.drain();

		expect(embedder.documents).toEqual(['Twice']);
	});

	it('embeds one Labour at a time', async () => {
		const ids = [labour('A'), labour('B'), labour('C'), labour('D')].map((l) => l.id);
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		for (const id of ids) queue.enqueue(id);
		await queue.drain();

		expect(embedder.documents).toHaveLength(4);
		expect(embedder.peak).toBe(1);
		expect([...readVectors(db, ids).keys()].sort()).toEqual([...ids].sort());
	});

	it('embeds in the order Labours were queued', async () => {
		const ids = [labour('First'), labour('Second'), labour('Third')].map((l) => l.id);
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		for (const id of ids) queue.enqueue(id);
		await queue.drain();

		expect(embedder.documents).toEqual(['First', 'Second', 'Third']);
	});

	it('skips a Labour that was deleted while it waited', async () => {
		const first = labour('First');
		const doomed = labour('Doomed');
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(first.id);
		queue.enqueue(doomed.id);
		deleteLabour(db, actor, doomed.id);
		await queue.drain();

		expect(embedder.documents).toEqual(['First']);
		expect(vectorRows().map((row) => row.labourId)).toEqual([first.id]);
	});

	it('skips an id that never existed', async () => {
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(987_654);

		await expect(queue.drain()).resolves.toBeUndefined();
		expect(embedder.documents).toEqual([]);
		expect(vectorRows()).toHaveLength(0);
	});

	it('skips a Labour whose vector is already current and leaves it untouched', async () => {
		const l = labour('Settled', 'body');
		const earlier = new Date('2026-01-02T03:04:05.000Z');
		writeVector(db, l.id, MODEL_ID, sha('Settled\n\nbody'), unitVector('kept'), earlier);
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(l.id);
		await queue.drain();

		expect(embedder.documents).toEqual([]);
		expect(vectorRow(l.id)!.embeddedAt.getTime()).toBe(earlier.getTime());
		expect(Array.from(readVectors(db, [l.id]).get(l.id)!)).toEqual(Array.from(unitVector('kept')));
	});

	it('re-embeds a Labour whose vector is stale by text', async () => {
		const l = labour('Before');
		embed(l.id, 'Before');
		updateLabour(db, actor, l.id, { title: 'After' });
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(l.id);
		await queue.drain();

		expect(embedder.documents).toEqual(['After']);
		expect(vectorRow(l.id)!.inputHash).toBe(sha('After'));
		expect(statusOf(l.id)).toBe('current');
	});

	it('re-embeds a Labour whose vector came from another model', async () => {
		const l = labour('Same text');
		embed(l.id, 'Same text', 'Xenova/bge-small-en-v1.5@0000000');
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(l.id);
		await queue.drain();

		expect(embedder.documents).toEqual(['Same text']);
		expect(vectorRow(l.id)!.model).toBe(MODEL_ID);
	});

	it('embeds the text as it stands when the Labour reaches the front', async () => {
		const ahead = labour('Ahead');
		const l = labour('Old title');
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(ahead.id);
		queue.enqueue(l.id);
		updateLabour(db, actor, l.id, { title: 'New title' });
		await queue.drain();

		expect(embedder.documents).toEqual(['Ahead', 'New title']);
		expect(statusOf(l.id)).toBe('current');
	});

	it('logs and drops a Labour whose embedding throws, then carries on', async () => {
		const before = labour('fine before');
		const bad = labour('boom');
		const after = labour('fine after');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const embedder = fakeEmbedder({ fail: (text) => text.includes('boom') });
		const queue = createEmbeddingQueue(db, embedder);

		queue.enqueue(before.id);
		queue.enqueue(bad.id);
		queue.enqueue(after.id);
		await expect(queue.drain()).resolves.toBeUndefined();

		expect(statusOf(before.id)).toBe('current');
		expect(statusOf(after.id)).toBe('current');
		expect(statusOf(bad.id)).toBe('absent');
		expect(embedder.documents.filter((text) => text === 'boom')).toHaveLength(1);
		expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(queue.size()).toBe(0);
	});

	it('queues a dropped Labour again when it is enqueued again', async () => {
		const l = labour('flaky');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const embedder = fakeEmbedder({ fail: () => true });
		const queue = createEmbeddingQueue(db, embedder);
		queue.enqueue(l.id);
		await queue.drain();
		expect(statusOf(l.id)).toBe('absent');

		embedder.fail = () => false;
		queue.enqueue(l.id);
		await queue.drain();

		expect(statusOf(l.id)).toBe('current');
	});

	it('resolves drain at once when nothing is queued', async () => {
		const queue = createEmbeddingQueue(db, fakeEmbedder());

		await expect(queue.drain()).resolves.toBeUndefined();
		expect(queue.size()).toBe(0);
	});

	it('resolves drain only after every queued Labour is done', async () => {
		const ids = [labour('A'), labour('B'), labour('C')].map((l) => l.id);
		const queue = createEmbeddingQueue(db, fakeEmbedder());

		for (const id of ids) queue.enqueue(id);
		await queue.drain();

		expect(vectorStatus(db, ids).get(ids[0])).toBe('current');
		expect(vectorStatus(db, ids).get(ids[1])).toBe('current');
		expect(vectorStatus(db, ids).get(ids[2])).toBe('current');
		expect(queue.size()).toBe(0);
	});

	it('counts the Labours still waiting', async () => {
		const ids = [labour('A'), labour('B'), labour('C')].map((l) => l.id);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const queue = createEmbeddingQueue(db, fakeEmbedder({ gate }));

		for (const id of ids) queue.enqueue(id);

		expect(queue.size()).toBeGreaterThanOrEqual(2);
		expect(queue.size()).toBeLessThanOrEqual(3);
		release();
		await queue.drain();
		expect(queue.size()).toBe(0);
	});
});

describe('queueing from text writes', () => {
	it('does nothing without a queue', () => {
		const l = labour('No queue');
		updateLabour(db, actor, l.id, { title: 'Still none' });

		expect(vectorRows()).toHaveLength(0);
		expect(statusOf(l.id)).toBe('absent');
	});

	it('does nothing once the queue is set back to null', async () => {
		const { embedder } = useRealQueue();
		setEmbeddingQueue(null);

		const l = labour('Unqueued');
		await new Promise((resolve) => setImmediate(resolve));

		expect(embedder.documents).toEqual([]);
		expect(statusOf(l.id)).toBe('absent');
	});

	describe('createLabour', () => {
		it('enqueues the new Labour after the transaction commits', () => {
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			const l = createLabour(db, actor, {
				realmId,
				title: 'Fresh',
				ownerId: seedUser(db, 'owner')
			});

			expect(spy.calls).toEqual([{ id: l.id, inTransaction: false }]);
			expect(db.select().from(labours).where(eq(labours.id, l.id)).get()).toBeDefined();
		});

		it('gets its vector from the real queue', async () => {
			const { queue, embedder } = useRealQueue();

			const l = labour('Embed me', 'please');
			await queue.drain();

			expect(embedder.documents).toEqual(['Embed me\n\nplease']);
			expect(statusOf(l.id)).toBe('current');
		});

		it('returns before the vector exists', async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const { queue } = useRealQueue(fakeEmbedder({ gate }));

			const l = labour('Slow model');

			expect(l.title).toBe('Slow model');
			expect(statusOf(l.id)).toBe('absent');
			release();
			await queue.drain();
			expect(statusOf(l.id)).toBe('current');
		});

		it('embeds nothing when the create fails', async () => {
			const { queue, embedder } = useRealQueue();

			expect(() =>
				createLabour(db, actor, { realmId, title: 'Orphan', ownerId: 987_654 })
			).toThrow();
			await queue.drain();

			expect(embedder.documents).toEqual([]);
			expect(vectorRows()).toHaveLength(0);
		});
	});

	describe('updateLabour', () => {
		it('enqueues after commit when the title changes', () => {
			const l = labour('Old');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			updateLabour(db, actor, l.id, { title: 'New' });

			expect(spy.calls).toEqual([{ id: l.id, inTransaction: false }]);
		});

		it('enqueues after commit when the description changes', () => {
			const l = labour('Title', 'old');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			updateLabour(db, actor, l.id, { description: 'new' });

			expect(spy.calls).toEqual([{ id: l.id, inTransaction: false }]);
		});

		it('enqueues once when title and description change together', () => {
			const l = labour('Title', 'old');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			updateLabour(db, actor, l.id, { title: 'New title', description: 'new' });

			expect(spy.ids()).toEqual([l.id]);
		});

		it('does not enqueue a labels-only change', () => {
			const l = labour('Title', 'body');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			updateLabour(db, actor, l.id, { labels: ['combat'] });
			updateLabour(db, actor, l.id, { addLabels: ['boss'] });
			updateLabour(db, actor, l.id, { removeLabels: ['combat'] });

			expect(spy.calls).toEqual([]);
		});

		it('does not enqueue an assignee change', () => {
			const l = labour('Title', 'body');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			updateLabour(db, actor, l.id, { assigneeId: seedUser(db, 'grace') });

			expect(spy.calls).toEqual([]);
		});

		it('does not enqueue when the update is refused', () => {
			const l = labour('Title');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			expect(() => updateLabour(db, actor, l.id, { title: '   ' })).toThrow();

			expect(spy.calls).toEqual([]);
		});

		it('refreshes a vector the update made stale', async () => {
			const { queue, embedder } = useRealQueue();
			const l = labour('Before');
			await queue.drain();

			updateLabour(db, actor, l.id, { title: 'After' });
			expect(statusOf(l.id)).toBe('stale');
			await queue.drain();

			expect(embedder.documents).toEqual(['Before', 'After']);
			expect(statusOf(l.id)).toBe('current');
		});

		it('returns before the new vector exists', async () => {
			const l = labour('Quick');
			embed(l.id, 'Quick');
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const { queue } = useRealQueue(fakeEmbedder({ gate }));

			updateLabour(db, actor, l.id, { title: 'Quicker' });

			expect(statusOf(l.id)).toBe('stale');
			release();
			await queue.drain();
			expect(statusOf(l.id)).toBe('current');
		});
	});

	describe('appraise', () => {
		it('enqueues after the write has committed, once the Brief is stored', () => {
			const l = labour('Title');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			appraise(db, actor, [{ labourId: l.id, brief: 'A Brief' }]);

			expect(spy.calls).toEqual([{ id: l.id, inTransaction: false }]);
			const stored = db.$client
				.prepare('SELECT brief FROM appraisals WHERE labour_id = ?')
				.get(l.id) as { brief: string };
			expect(stored.brief).toBe('A Brief');
		});

		it('enqueues every Labour in the batch that got a Brief', () => {
			const a = labour('A');
			const b = labour('B');
			const c = labour('C');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			appraise(db, actor, [
				{ labourId: a.id, brief: 'Brief A' },
				{ labourId: b.id, refs: [{ href: 'https://example.com' }] },
				{ labourId: c.id, brief: 'Brief C' }
			]);

			expect([...spy.ids()].sort()).toEqual([a.id, c.id].sort());
		});

		it('does not enqueue an item that writes no Brief', () => {
			const l = labour('Title');
			const spy = spyQueue();
			setEmbeddingQueue(spy.queue);

			appraise(db, actor, [{ labourId: l.id, refs: [{ href: 'https://example.com' }] }]);
			appraise(db, actor, [{ labourId: l.id }]);

			expect(spy.calls).toEqual([]);
		});

		it('embeds the Brief it wrote', async () => {
			const { queue, embedder } = useRealQueue();
			const l = labour('Title', 'Body');
			await queue.drain();

			appraise(db, actor, [{ labourId: l.id, brief: 'Boss wind-ups' }]);
			expect(statusOf(l.id)).toBe('stale');
			await queue.drain();

			expect(embedder.documents).toEqual(['Title\n\nBody', 'Title\n\nBoss wind-ups\n\nBody']);
			expect(statusOf(l.id)).toBe('current');
		});

		it('returns before the vector exists', async () => {
			const l = labour('Title');
			embed(l.id, 'Title');
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const { queue } = useRealQueue(fakeEmbedder({ gate }));

			appraise(db, actor, [{ labourId: l.id, brief: 'Brief' }]);

			expect(statusOf(l.id)).toBe('stale');
			release();
			await queue.drain();
			expect(statusOf(l.id)).toBe('current');
		});

		it('leaves nothing current for a Brief that was rolled back', async () => {
			const l = labour('Title', 'Body');
			const { queue, embedder } = useRealQueue();
			queue.enqueue(l.id);
			await queue.drain();

			expect(() =>
				appraise(db, actor, [
					{ labourId: l.id, brief: 'Rolled back Brief' },
					{ labourId: 987_654, brief: 'Nobody' }
				])
			).toThrow();
			await queue.drain();

			expect(embedder.documents).toEqual(['Title\n\nBody']);
			expect(vectorRow(l.id)!.inputHash).toBe(sha('Title\n\nBody'));
			expect(statusOf(l.id)).toBe('current');
		});
	});
});

describe('enqueueStale', () => {
	it('enqueues every Labour without a current vector and returns how many', async () => {
		const current = labour('Current');
		const staleText = labour('Stale text');
		const staleModel = labour('Stale model');
		const absentOne = labour('Absent one');
		const absentTwo = labour('Absent two');
		embed(current.id, 'Current');
		embed(staleText.id, 'Older text');
		embed(staleModel.id, 'Stale model', 'Xenova/bge-small-en-v1.5@0000000');
		const spy = spyQueue();

		const count = await enqueueStale(db, spy.queue);

		expect(count).toBe(4);
		expect([...spy.ids()].sort()).toEqual(
			[staleText.id, staleModel.id, absentOne.id, absentTwo.id].sort()
		);
	});

	it('returns 0 and enqueues nothing when every Labour is current', async () => {
		const a = labour('A');
		const b = labour('B');
		embed(a.id, 'A');
		embed(b.id, 'B');
		const spy = spyQueue();

		expect(await enqueueStale(db, spy.queue)).toBe(0);
		expect(spy.calls).toEqual([]);
	});

	it('returns 0 for an empty database', async () => {
		db.delete(labours).run();
		expect(await enqueueStale(db, spyQueue().queue)).toBe(0);
	});

	it('brings every Labour current through a real queue', async () => {
		const ids = [labour('A', 'one'), labour('B'), labour('C', 'three')].map((l) => l.id);
		embed(ids[1], 'B');
		const embedder = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);

		expect(await enqueueStale(db, queue)).toBe(2);
		await queue.drain();

		expect(embedder.documents.sort()).toEqual(['A\n\none', 'C\n\nthree']);
		for (const id of ids) expect(statusOf(id)).toBe('current');
		expect(await enqueueStale(db, queue)).toBe(0);
	});
});

describe('side effects', () => {
	it('records no Event and leaves updatedAt alone', async () => {
		const l = labour('Quiet', 'body');
		const other = labour('Also quiet');
		embed(other.id, 'Old text');
		const before = {
			events: db.select().from(events).all().length,
			updatedAt: db
				.select()
				.from(labours)
				.all()
				.map((row) => [row.id, row.updatedAt.getTime()])
		};
		const queue = createEmbeddingQueue(db, fakeEmbedder());

		writeVector(db, l.id, MODEL_ID, sha('Quiet\n\nbody'), unitVector('q'));
		await enqueueStale(db, queue);
		await queue.drain();

		expect(vectorRows()).toHaveLength(2);
		expect(db.select().from(events).all()).toHaveLength(before.events);
		expect(
			db
				.select()
				.from(labours)
				.all()
				.map((row) => [row.id, row.updatedAt.getTime()])
		).toEqual(before.updatedAt);
	});
});
