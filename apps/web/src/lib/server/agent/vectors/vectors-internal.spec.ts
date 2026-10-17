import { eq } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embeddingModelDir } from '#lib/server/config.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { Db } from '#lib/server/db/client.ts';
import { events, labourInputs, labours, labourVectors } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	createLabour,
	deleteLabour,
	rankLabour,
	updateLabour
} from '#lib/server/domain/labours.ts';
import { toolRegistry, type Registry } from '#lib/server/mcp/tool.ts';
import { registerSurveyTools } from '#lib/server/mcp/tools/survey.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { appraise } from '../appraisals.ts';
import { survey } from '../survey/index.ts';
import { similarity } from '../survey/features/similarity.ts';
import { loadEmbedder, MODEL_ID, setEmbedder, type Embedder } from './embedder.ts';
import {
	createEmbeddingQueue,
	enqueueStale,
	readVectors,
	setEmbeddingQueue,
	vectorStatus,
	writeVector,
	type EmbeddingQueue
} from './index.ts';
import { embeddingInput, inputHash } from './input.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

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
	setEmbedder(null);
	db.$client.close();
});

const unit = (...head: number[]) => {
	const vector = new Float32Array(384);
	head.forEach((value, i) => (vector[i] = value));
	return vector;
};

const textOf = (id: number) => {
	const row = db.select().from(labours).where(eq(labours.id, id)).get()!;
	const brief = appraisalBrief(id);
	return { title: row.title, brief, description: row.description };
};

const appraisalBrief = (id: number) =>
	(db.$client.prepare('SELECT brief FROM appraisals WHERE labour_id = ?').pluck().get(id) as
		string | undefined) ?? '';

const hashOf = (id: number) => inputHash(textOf(id));

const store = (id: number, vector = unit(1)) =>
	writeVector(db, id, MODEL_ID, hashOf(id), vector, NOW);

// Embeds to a vector derived from the text length, and records what it was asked.
function fakeEmbedder(over: Partial<Embedder> = {}) {
	const seen: string[] = [];
	let active = 0;
	let overlapped = false;
	const embedder: Embedder = {
		model: MODEL_ID,
		async embedDocument(text) {
			seen.push(text);
			active += 1;
			if (active > 1) overlapped = true;
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
			return unit(1, text.length / 1000);
		},
		async embedQuery() {
			return unit(1);
		},
		...over
	};
	return { embedder, seen, overlapped: () => overlapped };
}

describe('embedding input', () => {
	it('joins the trimmed title, Brief and description, dropping empty ones', () => {
		expect(embeddingInput({ title: ' T ', brief: '', description: 'D\n' })).toBe('T\n\nD');
		expect(embeddingInput({ title: 'T', brief: 'B', description: 'D' })).toBe('T\n\nB\n\nD');
	});

	it('hashes the joined input, so whitespace around a part does not change it', () => {
		expect(inputHash({ title: 'T', brief: '', description: '' })).toMatch(/^[0-9a-f]{64}$/);
		expect(inputHash({ title: ' T', brief: '', description: '' })).toBe(
			inputHash({ title: 'T', brief: '', description: '' })
		);
	});
});

describe('stored vectors', () => {
	it('round trips 384 float32 values in 1,536 bytes', () => {
		const labour = seedLabour(db, { realmId });
		const vector = Float32Array.from({ length: 384 }, (_, i) => Math.fround(Math.sin(i)));
		writeVector(db, labour.id, MODEL_ID, hashOf(labour.id), vector, NOW);
		const row = db.select().from(labourVectors).get()!;
		expect(row.vector.byteLength).toBe(1536);
		expect(new DataView(row.vector.buffer, row.vector.byteOffset).getFloat32(4, true)).toBe(
			vector[1]
		);
		expect(row.embeddedAt).toEqual(NOW);
		expect([...readVectors(db, [labour.id]).get(labour.id)!]).toEqual([...vector]);
	});

	it('replaces the row on a second write', () => {
		const labour = seedLabour(db, { realmId });
		store(labour.id, unit(1));
		store(labour.id, unit(0, 1));
		expect(db.select().from(labourVectors).all()).toHaveLength(1);
		expect(readVectors(db, [labour.id]).get(labour.id)![1]).toBe(1);
	});

	it('ignores a Labour that does not exist', () => {
		writeVector(db, 999, MODEL_ID, 'x'.repeat(64), unit(1), NOW);
		expect(db.select().from(labourVectors).all()).toEqual([]);
	});

	it('goes with the Labour', () => {
		const labour = seedLabour(db, { realmId });
		store(labour.id);
		deleteLabour(db, actor, labour.id);
		expect(db.select().from(labourVectors).all()).toEqual([]);
	});

	it('reports current, stale by text, stale by model, and absent', () => {
		const [a, b, c, d] = [1, 2, 3, 4].map(() => seedLabour(db, { realmId }));
		store(a.id);
		store(b.id);
		updateLabour(db, actor, b.id, { title: 'Changed' });
		writeVector(db, c.id, 'other@model', hashOf(c.id), unit(1), NOW);
		const status = vectorStatus(db, [a.id, b.id, c.id, d.id, 999]);
		expect([...status]).toEqual([
			[a.id, 'current'],
			[b.id, 'stale'],
			[c.id, 'stale'],
			[d.id, 'absent'],
			[999, 'absent']
		]);
		expect([...readVectors(db, [a.id, b.id, c.id, d.id]).keys()]).toEqual([a.id]);
	});

	it('goes stale when the Brief changes, and current again once re-embedded', () => {
		const labour = seedLabour(db, { realmId });
		store(labour.id);
		appraise(db, actor, [{ labourId: labour.id, brief: 'New Brief' }]);
		expect(vectorStatus(db, [labour.id]).get(labour.id)).toBe('stale');
		store(labour.id);
		expect(vectorStatus(db, [labour.id]).get(labour.id)).toBe('current');
	});

	it('leaves updated_at and the Events alone', () => {
		const labour = seedLabour(db, { realmId });
		const before = db.select().from(labours).get()!.updatedAt;
		const count = db.select().from(events).all().length;
		store(labour.id);
		expect(db.select().from(labours).get()!.updatedAt).toEqual(before);
		expect(db.select().from(events).all()).toHaveLength(count);
	});
});

describe('hooks after commit', () => {
	function spyQueue() {
		const calls: { id: number; visible: boolean; title: string | undefined }[] = [];
		const queue: EmbeddingQueue = {
			enqueue(id) {
				const row = db.select().from(labours).where(eq(labours.id, id)).get();
				calls.push({ id, visible: row !== undefined, title: row?.title });
			},
			drain: async () => {},
			size: () => 0
		};
		setEmbeddingQueue(queue);
		return calls;
	}

	it('does nothing without a queue', () => {
		expect(() => seedLabour(db, { realmId })).not.toThrow();
	});

	it('queues a new Labour once its row is committed', () => {
		const calls = spyQueue();
		const made = createLabour(db, actor, { realmId, title: 'Made', ownerId: actor.id });
		expect(calls).toEqual([{ id: made.id, visible: true, title: 'Made' }]);
	});

	it('queues nothing for a create that fails', () => {
		const calls = spyQueue();
		expect(() => createLabour(db, actor, { realmId, title: '  ', ownerId: actor.id })).toThrow(
			DomainError
		);
		expect(calls).toEqual([]);
	});

	it('queues a Labour whose title or description changed', () => {
		const labour = seedLabour(db, { realmId });
		const calls = spyQueue();
		updateLabour(db, actor, labour.id, { title: 'Retitled' });
		updateLabour(db, actor, labour.id, { description: 'Described' });
		expect(calls.map((call) => call.id)).toEqual([labour.id, labour.id]);
		expect(calls[0].title).toBe('Retitled');
	});

	it('queues nothing for a write that leaves the text as it was', () => {
		const labour = seedLabour(db, { realmId, title: 'Same' });
		const other = seedLabour(db, { realmId });
		const calls = spyQueue();
		updateLabour(db, actor, labour.id, { title: 'Same' });
		updateLabour(db, actor, labour.id, { labels: ['bug'], assigneeId: actor.id });
		rankLabour(db, actor, labour.id, { before: other.id });
		expect(calls).toEqual([]);
	});

	it('queues a Labour whose Brief changed, once per Labour in a batch', () => {
		const a = seedLabour(db, { realmId });
		const b = seedLabour(db, { realmId });
		const calls = spyQueue();
		appraise(db, actor, [
			{ labourId: a.id, brief: 'One' },
			{ labourId: b.id, refs: [{ href: 'https://example.com' }] }
		]);
		expect(calls.map((call) => call.id)).toEqual([a.id]);
		appraise(db, actor, [{ labourId: a.id, brief: 'One' }]);
		expect(calls).toHaveLength(1);
	});

	it('queues nothing when the Appraisal batch rolls back', () => {
		const a = seedLabour(db, { realmId });
		const calls = spyQueue();
		expect(() =>
			appraise(db, actor, [
				{ labourId: a.id, brief: 'Written then undone' },
				{ labourId: 999_999, brief: 'No such Labour' }
			])
		).toThrow(DomainError);
		expect(calls).toEqual([]);
		expect(appraisalBrief(a.id)).toBe('');
	});

	it('queues nothing when an update rolls back', () => {
		const labour = seedLabour(db, { realmId });
		const calls = spyQueue();
		expect(() => updateLabour(db, actor, labour.id, { title: 'Fine', ownerId: 999_999 })).toThrow(
			DomainError
		);
		expect(calls).toEqual([]);
	});

	it('does not wait for a vector', () => {
		const { embedder } = fakeEmbedder({ embedDocument: () => new Promise(() => {}) });
		setEmbeddingQueue(createEmbeddingQueue(db, embedder));
		const started = Date.now();
		seedLabour(db, { realmId });
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe('the embedding queue', () => {
	it('embeds each queued Labour from its present text and stores it current', async () => {
		const a = seedLabour(db, { realmId, title: 'Boss', description: 'Telegraph the slam' });
		appraise(db, actor, [{ labourId: a.id, brief: 'Combat feel' }]);
		const { embedder, seen } = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);
		queue.enqueue(a.id);
		await queue.drain();
		expect(seen).toEqual(['Boss\n\nCombat feel\n\nTelegraph the slam']);
		expect(vectorStatus(db, [a.id]).get(a.id)).toBe('current');
		expect(queue.size()).toBe(0);
	});

	it('embeds a Labour queued twice once', async () => {
		const a = seedLabour(db, { realmId });
		const { embedder, seen } = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);
		queue.enqueue(a.id);
		queue.enqueue(a.id);
		expect(queue.size()).toBe(1);
		await queue.drain();
		expect(seen).toHaveLength(1);
	});

	it('runs one Labour at a time', async () => {
		const ids = [1, 2, 3, 4].map(() => seedLabour(db, { realmId }).id);
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		ids.forEach((id) => queue.enqueue(id));
		await queue.drain();
		expect(fake.seen).toHaveLength(4);
		expect(fake.overlapped()).toBe(false);
	});

	it('skips a Labour that is already current or gone', async () => {
		const a = seedLabour(db, { realmId });
		const b = seedLabour(db, { realmId });
		store(a.id);
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		queue.enqueue(a.id);
		queue.enqueue(b.id);
		queue.enqueue(999_999);
		deleteLabour(db, actor, b.id);
		await queue.drain();
		expect(fake.seen).toEqual([]);
		expect(db.select().from(labourVectors).all()).toHaveLength(1);
	});

	it('logs and drops a Labour whose embedding throws, then carries on', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const a = seedLabour(db, { realmId, title: 'Bad' });
		const b = seedLabour(db, { realmId, title: 'Good' });
		const fake = fakeEmbedder({
			async embedDocument(text) {
				if (text.startsWith('Bad')) throw new Error('boom');
				return unit(1);
			}
		});
		const queue = createEmbeddingQueue(db, fake.embedder);
		queue.enqueue(a.id);
		queue.enqueue(b.id);
		await queue.drain();
		expect(error).toHaveBeenCalledOnce();
		expect(queue.size()).toBe(0);
		expect(vectorStatus(db, [a.id, b.id])).toEqual(
			new Map([
				[a.id, 'absent'],
				[b.id, 'current']
			])
		);
		error.mockRestore();
	});

	it('embeds again a Labour queued while its embedding runs, ending current', async () => {
		const a = seedLabour(db, { realmId, title: 'First' });
		let release!: () => void;
		let calls = 0;
		const fake = fakeEmbedder({
			async embedDocument() {
				calls += 1;
				if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
				return unit(1);
			}
		});
		const queue = createEmbeddingQueue(db, fake.embedder);
		queue.enqueue(a.id);
		await vi.waitFor(() => expect(calls).toBe(1));
		updateLabour(db, actor, a.id, { title: 'Second' });
		queue.enqueue(a.id);
		release();
		await queue.drain();
		expect(calls).toBe(2);
		expect(vectorStatus(db, [a.id]).get(a.id)).toBe('current');
	});

	it('has drain resolve at once when idle', async () => {
		const queue = createEmbeddingQueue(db, fakeEmbedder().embedder);
		await expect(queue.drain()).resolves.toBeUndefined();
	});

	it('picks up a write made through the process queue', async () => {
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		setEmbeddingQueue(queue);
		const made = seedLabour(db, { realmId, title: 'Hooked' });
		await queue.drain();
		expect(vectorStatus(db, [made.id]).get(made.id)).toBe('current');
		const before = db.select().from(labours).get()!.updatedAt;
		expect(before).toEqual(made.updatedAt);
	});

	it('enqueues every Labour without a current vector and returns how many', async () => {
		const [a, b, c] = [1, 2, 3].map(() => seedLabour(db, { realmId }));
		store(a.id);
		store(b.id);
		updateLabour(db, actor, b.id, { title: 'Moved on' });
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		expect(await enqueueStale(db, queue)).toBe(2);
		await queue.drain();
		expect(await enqueueStale(db, queue)).toBe(0);
		expect(vectorStatus(db, [a.id, b.id, c.id]).get(c.id)).toBe('current');
	});
});

describe('the similarity feature', () => {
	const context = (ids: number[], queryVector?: Float32Array) => {
		const candidates = ids.map((id) => ({ id })) as never;
		return {
			db,
			candidates,
			candidateIds: JSON.stringify(ids),
			query: 'q',
			forUserId: 1,
			now: NOW,
			queryVector
		};
	};

	it('scores (cosine - 0.45) / 0.55, clamped to [0, 1]', () => {
		const [a, b, c, d] = [1, 2, 3, 4].map(() => seedLabour(db, { realmId }));
		const at = (cosine: number) => unit(cosine, Math.sqrt(1 - cosine * cosine));
		store(a.id, unit(1));
		store(b.id, at(0.725));
		store(c.id, at(0.45));
		store(d.id, at(0.1));
		const scores = similarity.load(context([a.id, b.id, c.id, d.id], unit(1)));
		expect(scores.get(a.id)).toBeCloseTo(1, 5);
		expect(scores.get(b.id)).toBeCloseTo(0.5, 5);
		expect(scores.get(c.id)).toBeCloseTo(0, 5);
		expect(scores.get(d.id)).toBe(0);
	});

	it('leaves a Labour with no current vector missing', () => {
		const [a, b, c] = [1, 2, 3].map(() => seedLabour(db, { realmId }));
		store(a.id);
		store(b.id);
		updateLabour(db, actor, b.id, { title: 'Stale now' });
		const scores = similarity.load(context([a.id, b.id, c.id], unit(1)));
		expect([...scores]).toEqual([
			[a.id, 1],
			[b.id, null],
			[c.id, null]
		]);
	});

	it('leaves every candidate missing without a query vector', () => {
		const a = seedLabour(db, { realmId });
		store(a.id);
		expect([...similarity.load(context([a.id]))]).toEqual([[a.id, null]]);
	});

	it('reads vectors in a fixed number of statements, however many candidates', () => {
		const ids = Array.from({ length: 300 }, () => seedLabour(db, { realmId }).id);
		for (const id of ids) store(id);
		const prepare = vi.spyOn(db.$client, 'prepare');
		similarity.load(context(ids, unit(1)));
		expect(prepare.mock.calls.length).toBeLessThanOrEqual(6);
		prepare.mockRestore();
	});

	it('counts missing and unembedded in a Survey', () => {
		const [a, b, c] = [1, 2, 3].map(() => seedLabour(db, { realmId }));
		store(a.id, unit(1));
		store(b.id, unit(1));
		updateLabour(db, actor, b.id, { title: 'Stale now' });
		const result = survey(
			db,
			actor,
			{ weights: { similarity: 1 }, query: 'q', temperature: 0 },
			{ now: NOW, queryVector: unit(1) }
		);
		expect(result.coverage).toMatchObject({
			candidates: 3,
			unembedded: 2,
			missing: { similarity: 2 }
		});
		expect(result.results[0].labourId).toBe(a.id);
		expect(c.id).toBeGreaterThan(0);
	});

	it('counts every candidate missing when the Survey has no query vector', () => {
		const a = seedLabour(db, { realmId });
		store(a.id);
		const result = survey(db, actor, { weights: { similarity: 1 }, query: 'q', temperature: 0 });
		expect(result.ignored).toEqual([]);
		expect(result.coverage.missing).toEqual({ similarity: 1 });
		expect(result.coverage.unembedded).toBe(0);
	});
});

describe('the survey tool', () => {
	let registry: Registry;

	beforeEach(() => {
		registry = toolRegistry(db, seedHuman(db, 'ada'), 'http://sagas.test');
		registerSurveyTools(registry.tools);
	});

	const ask = async (args: Record<string, unknown>) => {
		const result = await registry.call('survey', { temperature: 0, ...args });
		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		return result.structuredContent as any;
	};

	it('embeds the query and ranks by similarity when an embedder is set', async () => {
		const near = seedLabour(db, { realmId, title: 'Near' });
		const far = seedLabour(db, { realmId, title: 'Far' });
		store(near.id, unit(1));
		store(far.id, unit(0, 1));
		const embedQuery = vi.fn(async () => unit(1));
		setEmbedder({ model: MODEL_ID, embedDocument: async () => unit(1), embedQuery });
		const data = await ask({ query: 'boss fights', weights: { similarity: 1 } });
		expect(embedQuery).toHaveBeenCalledWith('boss fights');
		expect(data.results.map((r: { title: string }) => r.title)).toEqual(['Near', 'Far']);
		expect(data.coverage.missing).toEqual({});
	});

	it('does not embed unless similarity is weighted and a query is given', async () => {
		seedLabour(db, { realmId });
		const embedQuery = vi.fn(async () => unit(1));
		setEmbedder({ model: MODEL_ID, embedDocument: async () => unit(1), embedQuery });
		await ask({ query: 'x', weights: { age: 1 } });
		await ask({ weights: { similarity: 1 } });
		await ask({ query: '   ', weights: { similarity: 1 } });
		expect(embedQuery).not.toHaveBeenCalled();
	});

	it('counts similarity missing, not ignored, without a model', async () => {
		const a = seedLabour(db, { realmId });
		store(a.id);
		const data = await ask({ query: 'x', weights: { similarity: 1 } });
		expect(data.ignored).toEqual([]);
		expect(data.coverage.missing).toEqual({ similarity: 1 });
	});
});

describe('the input hash', () => {
	const stored = (id: number) =>
		db.select().from(labourInputs).where(eq(labourInputs.labourId, id)).get()?.inputHash;

	it('is written with the Labour and follows title, description and Brief', () => {
		const a = seedLabour(db, { realmId, title: 'First', description: 'Body' });
		expect(stored(a.id)).toBe(inputHash({ title: 'First', brief: '', description: 'Body' }));

		updateLabour(db, actor, a.id, { title: 'Second' });
		expect(stored(a.id)).toBe(hashOf(a.id));
		updateLabour(db, actor, a.id, { description: 'Other body' });
		expect(stored(a.id)).toBe(hashOf(a.id));
		appraise(db, actor, [{ labourId: a.id, brief: 'A Brief' }]);
		expect(stored(a.id)).toBe(
			inputHash({ title: 'Second', brief: 'A Brief', description: 'Other body' })
		);
	});

	it('leaves the hash alone for a write that keeps the text', () => {
		const a = seedLabour(db, { realmId });
		const before = stored(a.id);
		updateLabour(db, actor, a.id, { labels: ['combat'] });
		appraise(db, actor, [{ labourId: a.id, refs: [{ href: 'https://x.test', label: null }] }]);
		expect(stored(a.id)).toBe(before);
	});

	it('rolls back with the write that failed', () => {
		const a = seedLabour(db, { realmId });
		const before = stored(a.id);
		expect(() =>
			appraise(db, actor, [
				{ labourId: a.id, brief: 'Never kept' },
				{ labourId: 999_999, brief: 'Missing' }
			])
		).toThrow(DomainError);
		expect(stored(a.id)).toBe(before);
	});

	it('goes with the Labour', () => {
		const a = seedLabour(db, { realmId });
		deleteLabour(db, actor, a.id);
		expect(db.select().from(labourInputs).all()).toEqual([]);
	});

	it('decides currency without reading the text', () => {
		const a = seedLabour(db, { realmId, description: 'Body' });
		store(a.id);
		db.update(labours)
			.set({ description: 'Written around the domain' })
			.where(eq(labours.id, a.id))
			.run();
		expect(vectorStatus(db, [a.id]).get(a.id)).toBe('current');
	});

	it('is refreshed by the worker from the text it embeds', async () => {
		const a = seedLabour(db, { realmId, title: 'Title', description: 'Body' });
		store(a.id);
		db.update(labours)
			.set({ description: 'Written around the domain' })
			.where(eq(labours.id, a.id))
			.run();
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		queue.enqueue(a.id);
		await queue.drain();
		expect(fake.seen).toEqual(['Title\n\nWritten around the domain']);
		expect(stored(a.id)).toBe(hashOf(a.id));
		expect(vectorStatus(db, [a.id]).get(a.id)).toBe('current');
	});

	it('reads vector status once per Survey, shared by similarity and coverage', () => {
		const ids = Array.from({ length: 50 }, () => seedLabour(db, { realmId }).id);
		for (const id of ids.slice(0, 40)) store(id);
		const prepare = vi.spyOn(db.$client, 'prepare');
		const result = survey(
			db,
			actor,
			{ weights: { similarity: 1, age: 1 }, query: 'q', temperature: 0 },
			{ now: NOW, queryVector: unit(1) }
		);
		const reads = prepare.mock.calls.filter(([text]) => text.includes('labour_vectors'));
		prepare.mockRestore();
		expect(reads).toHaveLength(1);
		expect(result.coverage).toMatchObject({ unembedded: 10, missing: { similarity: 10 } });
	});
});

describe('a vector of the wrong length', () => {
	function storeBlob(id: number, bytes: number) {
		db.$client
			.prepare(
				'INSERT INTO labour_vectors (labour_id, model, vector, input_hash, embedded_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run(id, MODEL_ID, Buffer.alloc(bytes), hashOf(id), NOW.getTime());
	}

	it('is stale, never read, and embedded again', async () => {
		const short = seedLabour(db, { realmId, title: 'Short' });
		const long = seedLabour(db, { realmId, title: 'Long' });
		storeBlob(short.id, 1_535);
		storeBlob(long.id, 1_540);

		expect([...vectorStatus(db, [short.id, long.id]).values()]).toEqual(['stale', 'stale']);
		expect(readVectors(db, [short.id, long.id]).size).toBe(0);
		const result = survey(
			db,
			actor,
			{ weights: { similarity: 1 }, query: 'q', temperature: 0 },
			{ now: NOW, queryVector: unit(1) }
		);
		expect(result.coverage).toMatchObject({ unembedded: 2, missing: { similarity: 2 } });

		const queue = createEmbeddingQueue(db, fakeEmbedder().embedder);
		expect(await enqueueStale(db, queue)).toBe(2);
		await queue.drain();
		expect([...vectorStatus(db, [short.id, long.id]).values()]).toEqual(['current', 'current']);
	});
});

describe('enqueueStale', () => {
	it('yields between chunks of 1,000 Labours', async () => {
		const base = seedLabour(db, { realmId });
		const rows = generateNKeysBetween(base.rank, null, 2_499).map((rank, i) => ({
			realmId,
			number: i + 2,
			title: `Labour ${i}`,
			ownerId: base.ownerId,
			stateId: base.stateId,
			rank
		}));
		const ids = [
			base.id,
			...db
				.insert(labours)
				.values(rows)
				.returning({ id: labours.id })
				.all()
				.map((row) => row.id)
		];
		const queued: number[] = [];
		const queue: EmbeddingQueue = {
			enqueue: (id) => queued.push(id),
			drain: async () => {},
			size: () => 0
		};

		const counting = enqueueStale(db, queue);
		expect(queued).toHaveLength(1_000);
		expect(await counting).toBe(2_500);
		expect(queued).toEqual(ids);
	});

	it("judges current by the queue's model, as its worker does", async () => {
		const ours = seedLabour(db, { realmId, title: 'Ours' });
		const theirs = seedLabour(db, { realmId, title: 'Theirs' });
		writeVector(db, ours.id, 'other@model', hashOf(ours.id), unit(1), NOW);
		store(theirs.id);
		const fake = fakeEmbedder({ model: 'other@model' });
		const queue = createEmbeddingQueue(db, fake.embedder);

		expect(await enqueueStale(db, queue)).toBe(1);
		await queue.drain();
		expect(fake.seen).toEqual(['Theirs']);
		expect(await enqueueStale(db, queue)).toBe(0);
	});
});

describe('a failing embedder', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function failing() {
		let broken = true;
		const fake = fakeEmbedder({
			async embedDocument() {
				if (broken) throw new Error('boom');
				return unit(1);
			}
		});
		return {
			embedder: fake.embedder,
			heal: () => (broken = false),
			breakAgain: () => (broken = true)
		};
	}

	it('logs three failures, then one line, then stops after 20 in a row and warns once', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ids = Array.from({ length: 30 }, () => seedLabour(db, { realmId }).id);
		const queue = createEmbeddingQueue(db, failing().embedder);

		for (const id of ids) queue.enqueue(id);
		await queue.drain();

		expect(error).toHaveBeenCalledTimes(4);
		expect(error.mock.calls.slice(0, 3).every(([, cause]) => cause instanceof Error)).toBe(true);
		expect(error.mock.calls[3]).toHaveLength(1);
		expect(warn).toHaveBeenCalledOnce();
		expect(queue.size()).toBe(10);

		queue.enqueue(ids[0]);
		await queue.drain();
		expect(error).toHaveBeenCalledTimes(4);
		expect(warn).toHaveBeenCalledOnce();
		expect(queue.size()).toBe(10);
	});

	it('picks up again on a later enqueue once the embedder works, and logs a new outage', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ids = Array.from({ length: 25 }, () => seedLabour(db, { realmId }).id);
		const fake = failing();
		const queue = createEmbeddingQueue(db, fake.embedder);
		for (const id of ids) queue.enqueue(id);
		await queue.drain();
		expect(queue.size()).toBe(5);

		fake.heal();
		const late = seedLabour(db, { realmId }).id;
		queue.enqueue(late);
		await queue.drain();
		expect(queue.size()).toBe(0);
		expect(vectorStatus(db, [late]).get(late)).toBe('current');

		error.mockClear();
		fake.breakAgain();
		queue.enqueue(seedLabour(db, { realmId }).id);
		await queue.drain();
		expect(error).toHaveBeenCalledOnce();
	});
});

describe('the survey tool, guarding the Survey', () => {
	let registry: Registry;

	beforeEach(() => {
		registry = toolRegistry(db, seedHuman(db, 'ada'), 'http://sagas.test');
		registerSurveyTools(registry.tools);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('never embeds for a request it refuses', async () => {
		seedLabour(db, { realmId });
		const embedQuery = vi.fn(async () => unit(1));
		setEmbedder({ model: MODEL_ID, embedDocument: async () => unit(1), embedQuery });

		const refused = [
			{ query: 'q', weights: { similarity: 99 } },
			{ query: 'q', weights: { similarity: 1 }, temperature: 5 },
			{ query: 'q'.repeat(501), weights: { similarity: 1 } }
		];
		for (const args of refused) {
			const result = await registry.call('survey', args);
			expect(result.isError, JSON.stringify(args)).toBe(true);
		}
		expect(embedQuery).not.toHaveBeenCalled();
	});

	it('counts similarity missing when embedding the query throws, warning once per outage', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const a = seedLabour(db, { realmId });
		store(a.id);
		let broken = false;
		setEmbedder({
			model: MODEL_ID,
			embedDocument: async () => unit(1),
			embedQuery: async () => {
				if (broken) throw new Error('boom');
				return unit(1);
			}
		});
		const ask = async () => {
			const result = await registry.call('survey', {
				query: 'q',
				weights: { similarity: 1 },
				temperature: 0
			});
			expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
			return result.structuredContent as { coverage: { missing: Record<string, number> } };
		};

		expect((await ask()).coverage.missing).toEqual({});
		broken = true;
		expect((await ask()).coverage.missing).toEqual({ similarity: 1 });
		expect((await ask()).coverage.missing).toEqual({ similarity: 1 });
		expect(warn).toHaveBeenCalledOnce();

		broken = false;
		expect((await ask()).coverage.missing).toEqual({});
		broken = true;
		await ask();
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('gives up on the query vector after 10 seconds', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const a = seedLabour(db, { realmId });
		store(a.id);
		setEmbedder({
			model: MODEL_ID,
			embedDocument: async () => unit(1),
			embedQuery: () => new Promise<Float32Array>(() => {})
		});

		const pending = registry.call('survey', {
			query: 'q',
			weights: { similarity: 1 },
			temperature: 0
		});
		await vi.advanceTimersByTimeAsync(9_999);
		let settled = false;
		void pending.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const result = await pending;
		expect(result.isError).not.toBe(true);
		expect((result.structuredContent as any).coverage.missing).toEqual({ similarity: 1 });
	});
});

describe.skipIf(!existsSync(join(embeddingModelDir, 'Xenova/bge-small-en-v1.5/config.json')))(
	'the shipped model',
	() => {
		it('ranks a Survey by meaning through the queue', { timeout: 60_000 }, async () => {
			const embedder = (await loadEmbedder(embeddingModelDir))!;
			const boss = seedLabour(db, {
				realmId,
				title: 'Tune boss fight difficulty',
				description: 'Adjust boss HP and damage so the encounter feels fair and combat feels punchy'
			});
			const icon = seedLabour(db, {
				realmId,
				title: 'Fix inventory icon alignment',
				description: 'The sword icon sits two pixels left of the grid in the inventory panel'
			});
			const queue = createEmbeddingQueue(db, embedder);
			await enqueueStale(db, queue);
			await queue.drain();
			const queryVector = await embedder.embedQuery('improve combat feel for boss fights');
			const result = survey(
				db,
				actor,
				{
					weights: { similarity: 1 },
					query: 'improve combat feel for boss fights',
					temperature: 0
				},
				{ now: NOW, queryVector }
			);
			expect(result.results.map((r) => r.labourId)).toEqual([boss.id, icon.id]);
			expect(result.results[0].score).toBeGreaterThan(0.5);
			expect(result.results[1].score).toBeLessThan(0.3);
			expect(result.coverage.unembedded).toBe(0);
		});
	}
);
