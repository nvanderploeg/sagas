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
import { testDb, countStatements, spyStatements, expectResolves } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { appraise } from '../appraisals.ts';
import { survey } from '../survey/index.ts';
import { embeddedCount, embeddedOf } from '../survey/features/similarity.ts';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
});

afterEach(() => {
	setEmbeddingQueue(null);
	setEmbedder(null);
});

const unit = (...head: number[]) => {
	const vector = new Float32Array(384);
	head.forEach((value, i) => (vector[i] = value));
	return vector;
};

const textOf = async (id: number) => {
	const row = (await db.select().from(labours).where(eq(labours.id, id)).limit(1))[0]!;
	const brief = await appraisalBrief(id);
	return { title: row.title, brief, description: row.description };
};

const appraisalBrief = async (id: number) =>
	(
		await db.$client.query<{ brief: string }>('SELECT brief FROM appraisals WHERE labour_id = $1', [
			id
		])
	).rows[0]?.brief ?? '';

const hashOf = async (id: number) => inputHash(await textOf(id));

const store = async (id: number, vector = unit(1)) =>
	writeVector(db, id, MODEL_ID, await hashOf(id), vector, NOW);

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
	it('round trips 384 float32 values in 1,536 bytes', async () => {
		const labour = await seedLabour(db, { realmId });
		const vector = Float32Array.from({ length: 384 }, (_, i) => Math.fround(Math.sin(i)));
		await writeVector(db, labour.id, MODEL_ID, await hashOf(labour.id), vector, NOW);
		const row = (await db.select().from(labourVectors).limit(1))[0]!;
		expect(row.vector.byteLength).toBe(1536);
		expect(new DataView(row.vector.buffer, row.vector.byteOffset).getFloat32(4, true)).toBe(
			vector[1]
		);
		expect(row.embeddedAt).toEqual(NOW);
		expect([...(await readVectors(db, [labour.id])).get(labour.id)!]).toEqual([...vector]);
	});

	it('replaces the row on a second write', async () => {
		const labour = await seedLabour(db, { realmId });
		await store(labour.id, unit(1));
		await store(labour.id, unit(0, 1));
		expect(await db.select().from(labourVectors)).toHaveLength(1);
		expect((await readVectors(db, [labour.id])).get(labour.id)![1]).toBe(1);
	});

	it('ignores a Labour that does not exist', async () => {
		await writeVector(db, 999, MODEL_ID, 'x'.repeat(64), unit(1), NOW);
		expect(await db.select().from(labourVectors)).toEqual([]);
	});

	it('goes with the Labour', async () => {
		const labour = await seedLabour(db, { realmId });
		await store(labour.id);
		await deleteLabour(db, actor, labour.id);
		expect(await db.select().from(labourVectors)).toEqual([]);
	});

	it('reports current, stale by text, stale by model, and absent', async () => {
		const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => seedLabour(db, { realmId })));
		await store(a.id);
		await store(b.id);
		await updateLabour(db, actor, b.id, { title: 'Changed' });
		await writeVector(db, c.id, 'other@model', await hashOf(c.id), unit(1), NOW);
		const status = await vectorStatus(db, [a.id, b.id, c.id, d.id, 999]);
		expect([...status]).toEqual([
			[a.id, 'current'],
			[b.id, 'stale'],
			[c.id, 'stale'],
			[d.id, 'absent'],
			[999, 'absent']
		]);
		expect([...(await readVectors(db, [a.id, b.id, c.id, d.id])).keys()]).toEqual([a.id]);
	});

	it('goes stale when the Brief changes, and current again once re-embedded', async () => {
		const labour = await seedLabour(db, { realmId });
		await store(labour.id);
		await appraise(db, actor, [{ labourId: labour.id, brief: 'New Brief' }]);
		expect((await vectorStatus(db, [labour.id])).get(labour.id)).toBe('stale');
		await store(labour.id);
		expect((await vectorStatus(db, [labour.id])).get(labour.id)).toBe('current');
	});

	it('leaves updated_at and the Events alone', async () => {
		const labour = await seedLabour(db, { realmId });
		const before = (await db.select().from(labours).limit(1))[0]!.updatedAt;
		const count = (await db.select().from(events)).length;
		await store(labour.id);
		expect((await db.select().from(labours).limit(1))[0]!.updatedAt).toEqual(before);
		expect(await db.select().from(events)).toHaveLength(count);
	});
});

describe('hooks after commit', () => {
	function spyQueue() {
		const calls: { id: number; visible: boolean; title: string | undefined }[] = [];
		const reads: Promise<unknown>[] = [];
		const queue: EmbeddingQueue = {
			enqueue(id) {
				const entry = { id, visible: false, title: undefined as string | undefined };
				calls.push(entry);
				reads.push(
					db
						.select()
						.from(labours)
						.where(eq(labours.id, id))
						.limit(1)
						.then(([row]) =>
							Object.assign(entry, { visible: row !== undefined, title: row?.title })
						)
				);
			},
			drain: async () => {},
			size: () => 0
		};
		setEmbeddingQueue(queue);
		return { calls, settle: () => Promise.all(reads) };
	}

	it('does nothing without a queue', async () => {
		await expectResolves(seedLabour(db, { realmId }));
	});

	it('queues a new Labour once its row is committed', async () => {
		const { calls, settle } = spyQueue();
		const made = await createLabour(db, actor, { realmId, title: 'Made', ownerId: actor.id });
		await settle();
		expect(calls).toEqual([{ id: made.id, visible: true, title: 'Made' }]);
	});

	it('queues nothing for a create that fails', async () => {
		const { calls, settle } = spyQueue();
		await expect(
			createLabour(db, actor, { realmId, title: '  ', ownerId: actor.id })
		).rejects.toThrow(DomainError);
		await settle();
		expect(calls).toEqual([]);
	});

	it('queues a Labour whose title or description changed', async () => {
		const labour = await seedLabour(db, { realmId });
		const { calls, settle } = spyQueue();
		await updateLabour(db, actor, labour.id, { title: 'Retitled' });
		await updateLabour(db, actor, labour.id, { description: 'Described' });
		await settle();
		expect(calls.map((call) => call.id)).toEqual([labour.id, labour.id]);
		await settle();
		expect(calls[0].title).toBe('Retitled');
	});

	it('queues nothing for a write that leaves the text as it was', async () => {
		const labour = await seedLabour(db, { realmId, title: 'Same' });
		const other = await seedLabour(db, { realmId });
		const { calls, settle } = spyQueue();
		await updateLabour(db, actor, labour.id, { title: 'Same' });
		await updateLabour(db, actor, labour.id, { labels: ['bug'], assigneeId: actor.id });
		await rankLabour(db, actor, labour.id, { before: other.id });
		await settle();
		expect(calls).toEqual([]);
	});

	it('queues a Labour whose Brief changed, once per Labour in a batch', async () => {
		const a = await seedLabour(db, { realmId });
		const b = await seedLabour(db, { realmId });
		const { calls, settle } = spyQueue();
		await appraise(db, actor, [
			{ labourId: a.id, brief: 'One' },
			{ labourId: b.id, refs: [{ href: 'https://example.com' }] }
		]);
		await settle();
		expect(calls.map((call) => call.id)).toEqual([a.id]);
		await appraise(db, actor, [{ labourId: a.id, brief: 'One' }]);
		await settle();
		expect(calls).toHaveLength(1);
	});

	it('queues nothing when the Appraisal batch rolls back', async () => {
		const a = await seedLabour(db, { realmId });
		const { calls, settle } = spyQueue();
		await expect(
			appraise(db, actor, [
				{ labourId: a.id, brief: 'Written then undone' },
				{ labourId: 999_999, brief: 'No such Labour' }
			])
		).rejects.toThrow(DomainError);
		await settle();
		expect(calls).toEqual([]);
		expect(await appraisalBrief(a.id)).toBe('');
	});

	it('queues nothing when an update rolls back', async () => {
		const labour = await seedLabour(db, { realmId });
		const { calls, settle } = spyQueue();
		await expect(
			updateLabour(db, actor, labour.id, { title: 'Fine', ownerId: 999_999 })
		).rejects.toThrow(DomainError);
		await settle();
		expect(calls).toEqual([]);
	});

	it('does not wait for a vector', async () => {
		const { embedder } = fakeEmbedder({ embedDocument: () => new Promise(() => {}) });
		setEmbeddingQueue(createEmbeddingQueue(db, embedder));
		const started = Date.now();
		await seedLabour(db, { realmId });
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe('the embedding queue', () => {
	it('embeds each queued Labour from its present text and stores it current', async () => {
		const a = await seedLabour(db, { realmId, title: 'Boss', description: 'Telegraph the slam' });
		await appraise(db, actor, [{ labourId: a.id, brief: 'Combat feel' }]);
		const { embedder, seen } = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);
		queue.enqueue(a.id);
		await queue.drain();
		expect(seen).toEqual(['Boss\n\nCombat feel\n\nTelegraph the slam']);
		expect((await vectorStatus(db, [a.id])).get(a.id)).toBe('current');
		expect(queue.size()).toBe(0);
	});

	it('embeds a Labour queued twice once', async () => {
		const a = await seedLabour(db, { realmId });
		const { embedder, seen } = fakeEmbedder();
		const queue = createEmbeddingQueue(db, embedder);
		queue.enqueue(a.id);
		queue.enqueue(a.id);
		expect(queue.size()).toBe(1);
		await queue.drain();
		expect(seen).toHaveLength(1);
	});

	it('runs one Labour at a time', async () => {
		const ids = await Promise.all(
			[1, 2, 3, 4].map(async () => (await seedLabour(db, { realmId })).id)
		);
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		ids.forEach((id) => queue.enqueue(id));
		await queue.drain();
		expect(fake.seen).toHaveLength(4);
		expect(fake.overlapped()).toBe(false);
	});

	it('skips a Labour that is already current or gone', async () => {
		const a = await seedLabour(db, { realmId });
		const b = await seedLabour(db, { realmId });
		await store(a.id);
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		queue.enqueue(a.id);
		queue.enqueue(b.id);
		queue.enqueue(999_999);
		await deleteLabour(db, actor, b.id);
		await queue.drain();
		expect(fake.seen).toEqual([]);
		expect(await db.select().from(labourVectors)).toHaveLength(1);
	});

	it('logs and drops a Labour whose embedding throws, then carries on', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const a = await seedLabour(db, { realmId, title: 'Bad' });
		const b = await seedLabour(db, { realmId, title: 'Good' });
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
		expect(await vectorStatus(db, [a.id, b.id])).toEqual(
			new Map([
				[a.id, 'absent'],
				[b.id, 'current']
			])
		);
		error.mockRestore();
	});

	it('embeds again a Labour queued while its embedding runs, ending current', async () => {
		const a = await seedLabour(db, { realmId, title: 'First' });
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
		await updateLabour(db, actor, a.id, { title: 'Second' });
		queue.enqueue(a.id);
		release();
		await queue.drain();
		expect(calls).toBe(2);
		expect((await vectorStatus(db, [a.id])).get(a.id)).toBe('current');
	});

	it('has drain resolve at once when idle', async () => {
		const queue = createEmbeddingQueue(db, fakeEmbedder().embedder);
		await expect(queue.drain()).resolves.toBeUndefined();
	});

	it('picks up a write made through the process queue', async () => {
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		setEmbeddingQueue(queue);
		const made = await seedLabour(db, { realmId, title: 'Hooked' });
		await queue.drain();
		expect((await vectorStatus(db, [made.id])).get(made.id)).toBe('current');
		const before = (await db.select().from(labours).limit(1))[0]!.updatedAt;
		expect(before).toEqual(made.updatedAt);
	});

	it('enqueues every Labour without a current vector and returns how many', async () => {
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => seedLabour(db, { realmId })));
		await store(a.id);
		await store(b.id);
		await updateLabour(db, actor, b.id, { title: 'Moved on' });
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		expect(await enqueueStale(db, queue)).toBe(2);
		await queue.drain();
		expect(await enqueueStale(db, queue)).toBe(0);
		expect((await vectorStatus(db, [a.id, b.id, c.id])).get(c.id)).toBe('current');
	});
});

describe('the similarity feature', () => {
	const context = (ids: number[], queryVector?: Float32Array) => {
		const candidates = ids.map((id) => ({ id })) as never;
		return {
			db,
			candidates,
			candidateIds: ids,
			query: 'q',
			forUserId: 1,
			now: NOW,
			queryVector
		};
	};

	it('scores (cosine - 0.45) / 0.55, clamped to [0, 1]', async () => {
		const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => seedLabour(db, { realmId })));
		const at = (cosine: number) => unit(cosine, Math.sqrt(1 - cosine * cosine));
		await store(a.id, unit(1));
		await store(b.id, at(0.725));
		await store(c.id, at(0.45));
		await store(d.id, at(0.1));
		const scores = await similarity.load(context([a.id, b.id, c.id, d.id], unit(1)));
		expect(scores.get(a.id)).toBeCloseTo(1, 5);
		expect(scores.get(b.id)).toBeCloseTo(0.5, 5);
		expect(scores.get(c.id)).toBeCloseTo(0, 5);
		expect(scores.get(d.id)).toBe(0);
	});

	it('leaves a Labour with no current vector missing', async () => {
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => seedLabour(db, { realmId })));
		await store(a.id);
		await store(b.id);
		await updateLabour(db, actor, b.id, { title: 'Stale now' });
		const scores = await similarity.load(context([a.id, b.id, c.id], unit(1)));
		expect([...scores]).toEqual([
			[a.id, 1],
			[b.id, null],
			[c.id, null]
		]);
	});

	it('leaves every candidate missing without a query vector', async () => {
		const a = await seedLabour(db, { realmId });
		await store(a.id);
		expect([...(await similarity.load(context([a.id])))]).toEqual([[a.id, null]]);
	});

	it('reads vectors in a fixed number of statements, however many candidates', async () => {
		const ids = await Promise.all(
			Array.from({ length: 300 }, async () => (await seedLabour(db, { realmId })).id)
		);
		for (const id of ids) await store(id);
		expect(await countStatements(() => similarity.load(context(ids, unit(1))))).toBeLessThanOrEqual(
			8
		);
	}, 30_000);

	it('counts current vectors as many as it loads, without reading a blob', async () => {
		const [current, stale, other] = await Promise.all(
			[1, 2, 3, 4].map(() => seedLabour(db, { realmId }))
		);
		await store(current.id);
		await store(stale.id);
		await updateLabour(db, actor, stale.id, { title: 'Stale now' });
		await writeVector(db, other.id, 'other-model', await hashOf(other.id), unit(1), NOW);
		const ids = (await db.select({ id: labours.id }).from(labours)).map((row) => row.id);

		const spy = spyStatements();
		const counted = await embeddedCount(context(ids));
		const sql = spy.texts();
		spy.stop();

		expect(counted).toBe((await embeddedOf(context(ids))).size);
		expect(counted).toBe(1);
		expect(sql.some((text) => /count\(\*\)/i.test(text))).toBe(true);
		expect(sql.some((text) => /v\.vector\s+AS/i.test(text))).toBe(false);
	});

	it('reuses the loaded vectors when the Survey weights similarity', async () => {
		const a = await seedLabour(db, { realmId });
		await seedLabour(db, { realmId });
		await store(a.id);
		const ctx = context([a.id], unit(1));
		await similarity.load(ctx);
		let counted = 0;
		expect(await countStatements(async () => (counted = await embeddedCount(ctx)))).toBe(0);
		expect(counted).toBe(1);
	});

	it('counts missing and unembedded in a Survey', async () => {
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => seedLabour(db, { realmId })));
		await store(a.id, unit(1));
		await store(b.id, unit(1));
		await updateLabour(db, actor, b.id, { title: 'Stale now' });
		const result = await survey(
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

	it('counts every candidate missing when the Survey has no query vector', async () => {
		const a = await seedLabour(db, { realmId });
		await store(a.id);
		const result = await survey(db, actor, {
			weights: { similarity: 1 },
			query: 'q',
			temperature: 0
		});
		expect(result.ignored).toEqual([]);
		expect(result.coverage.missing).toEqual({ similarity: 1 });
		expect(result.coverage.unembedded).toBe(0);
	});
});

describe('the survey tool', () => {
	let registry: Registry;

	beforeEach(async () => {
		registry = toolRegistry(db, await seedHuman(db, 'ada'), 'http://sagas.test');
		registerSurveyTools(registry.tools);
	});

	const ask = async (args: Record<string, unknown>) => {
		const result = await registry.call('survey', { temperature: 0, ...args });
		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		return result.structuredContent as any;
	};

	it('embeds the query and ranks by similarity when an embedder is set', async () => {
		const near = await seedLabour(db, { realmId, title: 'Near' });
		const far = await seedLabour(db, { realmId, title: 'Far' });
		await store(near.id, unit(1));
		await store(far.id, unit(0, 1));
		const embedQuery = vi.fn(async () => unit(1));
		setEmbedder({ model: MODEL_ID, embedDocument: async () => unit(1), embedQuery });
		const data = await ask({ query: 'boss fights', weights: { similarity: 1 } });
		expect(embedQuery).toHaveBeenCalledWith('boss fights');
		expect(data.results.map((r: { title: string }) => r.title)).toEqual(['Near', 'Far']);
		expect(data.coverage.missing).toEqual({});
	});

	it('does not embed unless similarity is weighted and a query is given', async () => {
		await seedLabour(db, { realmId });
		const embedQuery = vi.fn(async () => unit(1));
		setEmbedder({ model: MODEL_ID, embedDocument: async () => unit(1), embedQuery });
		await ask({ query: 'x', weights: { age: 1 } });
		await ask({ weights: { similarity: 1 } });
		await ask({ query: '   ', weights: { similarity: 1 } });
		expect(embedQuery).not.toHaveBeenCalled();
	});

	it('counts similarity missing, not ignored, without a model', async () => {
		const a = await seedLabour(db, { realmId });
		await store(a.id);
		const data = await ask({ query: 'x', weights: { similarity: 1 } });
		expect(data.ignored).toEqual([]);
		expect(data.coverage.missing).toEqual({ similarity: 1 });
	});
});

describe('the input hash', () => {
	const stored = async (id: number) =>
		(await db.select().from(labourInputs).where(eq(labourInputs.labourId, id)).limit(1))[0]
			?.inputHash;

	it('is written with the Labour and follows title, description and Brief', async () => {
		const a = await seedLabour(db, { realmId, title: 'First', description: 'Body' });
		expect(await stored(a.id)).toBe(inputHash({ title: 'First', brief: '', description: 'Body' }));

		await updateLabour(db, actor, a.id, { title: 'Second' });
		expect(await stored(a.id)).toBe(await hashOf(a.id));
		await updateLabour(db, actor, a.id, { description: 'Other body' });
		expect(await stored(a.id)).toBe(await hashOf(a.id));
		await appraise(db, actor, [{ labourId: a.id, brief: 'A Brief' }]);
		expect(await stored(a.id)).toBe(
			inputHash({ title: 'Second', brief: 'A Brief', description: 'Other body' })
		);
	});

	it('leaves the hash alone for a write that keeps the text', async () => {
		const a = await seedLabour(db, { realmId });
		const before = await stored(a.id);
		await updateLabour(db, actor, a.id, { labels: ['combat'] });
		await appraise(db, actor, [
			{ labourId: a.id, refs: [{ href: 'https://x.test', label: null }] }
		]);
		expect(await stored(a.id)).toBe(before);
	});

	it('rolls back with the write that failed', async () => {
		const a = await seedLabour(db, { realmId });
		const before = await stored(a.id);
		await expect(
			appraise(db, actor, [
				{ labourId: a.id, brief: 'Never kept' },
				{ labourId: 999_999, brief: 'Missing' }
			])
		).rejects.toThrow(DomainError);
		expect(await stored(a.id)).toBe(before);
	});

	it('goes with the Labour', async () => {
		const a = await seedLabour(db, { realmId });
		await deleteLabour(db, actor, a.id);
		expect(await db.select().from(labourInputs)).toEqual([]);
	});

	it('decides currency without reading the text', async () => {
		const a = await seedLabour(db, { realmId, description: 'Body' });
		await store(a.id);
		await db
			.update(labours)
			.set({ description: 'Written around the domain' })
			.where(eq(labours.id, a.id));
		expect((await vectorStatus(db, [a.id])).get(a.id)).toBe('current');
	});

	it('is refreshed by the worker from the text it embeds', async () => {
		const a = await seedLabour(db, { realmId, title: 'Title', description: 'Body' });
		await store(a.id);
		await db
			.update(labours)
			.set({ description: 'Written around the domain' })
			.where(eq(labours.id, a.id));
		const fake = fakeEmbedder();
		const queue = createEmbeddingQueue(db, fake.embedder);
		queue.enqueue(a.id);
		await queue.drain();
		expect(fake.seen).toEqual(['Title\n\nWritten around the domain']);
		expect(await stored(a.id)).toBe(await hashOf(a.id));
		expect((await vectorStatus(db, [a.id])).get(a.id)).toBe('current');
	});

	it('reads vector status once per Survey, shared by similarity and coverage', async () => {
		const ids = await Promise.all(
			Array.from({ length: 50 }, async () => (await seedLabour(db, { realmId })).id)
		);
		for (const id of ids.slice(0, 40)) await store(id);
		const spy = spyStatements();
		const result = await survey(
			db,
			actor,
			{ weights: { similarity: 1, age: 1 }, query: 'q', temperature: 0 },
			{ now: NOW, queryVector: unit(1) }
		);
		const reads = spy
			.texts()
			.filter((text) => /^\s*select/i.test(text) && text.includes('labour_vectors'));
		spy.stop();
		expect(reads).toHaveLength(1);
		expect(result.coverage).toMatchObject({ unembedded: 10, missing: { similarity: 10 } });
	});
});

describe('a vector of the wrong length', () => {
	async function storeBlob(id: number, bytes: number) {
		await db.$client.query(
			'INSERT INTO labour_vectors (labour_id, model, vector, input_hash, embedded_at) VALUES ($1, $2, $3, $4, $5)',
			[id, MODEL_ID, Buffer.alloc(bytes), await hashOf(id), NOW.getTime()]
		);
	}

	it('is stale, never read, and embedded again', async () => {
		const short = await seedLabour(db, { realmId, title: 'Short' });
		const long = await seedLabour(db, { realmId, title: 'Long' });
		await storeBlob(short.id, 1_535);
		await storeBlob(long.id, 1_540);

		expect([...(await vectorStatus(db, [short.id, long.id])).values()]).toEqual(['stale', 'stale']);
		expect((await readVectors(db, [short.id, long.id])).size).toBe(0);
		const result = await survey(
			db,
			actor,
			{ weights: { similarity: 1 }, query: 'q', temperature: 0 },
			{ now: NOW, queryVector: unit(1) }
		);
		expect(result.coverage).toMatchObject({ unembedded: 2, missing: { similarity: 2 } });

		const queue = createEmbeddingQueue(db, fakeEmbedder().embedder);
		expect(await enqueueStale(db, queue)).toBe(2);
		await queue.drain();
		expect([...(await vectorStatus(db, [short.id, long.id])).values()]).toEqual([
			'current',
			'current'
		]);
	});
});

describe('enqueueStale', () => {
	it('yields between chunks of 1,000 Labours', async () => {
		const base = await seedLabour(db, { realmId });
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
			...(await db.insert(labours).values(rows).returning({ id: labours.id })).map((row) => row.id)
		];
		const ticks = { n: 0, on: true };
		const tick = () => {
			ticks.n += 1;
			if (ticks.on) setImmediate(tick);
		};
		setImmediate(tick);
		const queued: { id: number; tick: number }[] = [];
		const queue: EmbeddingQueue = {
			enqueue: (id) => queued.push({ id, tick: ticks.n }),
			drain: async () => {},
			size: () => 0
		};

		const counting = await enqueueStale(db, queue);
		ticks.on = false;

		expect(counting).toBe(2_500);
		expect(queued.map((entry) => entry.id)).toEqual(ids);
		const chunks = [...Map.groupBy(queued, (entry) => entry.tick).values()].map((g) => g.length);
		expect(chunks).toEqual([1_000, 1_000, 500]);
	});

	it("judges current by the queue's model, as its worker does", async () => {
		const ours = await seedLabour(db, { realmId, title: 'Ours' });
		const theirs = await seedLabour(db, { realmId, title: 'Theirs' });
		await writeVector(db, ours.id, 'other@model', await hashOf(ours.id), unit(1), NOW);
		await store(theirs.id);
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
		const ids = await Promise.all(
			Array.from({ length: 30 }, async () => (await seedLabour(db, { realmId })).id)
		);
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
		const ids = await Promise.all(
			Array.from({ length: 25 }, async () => (await seedLabour(db, { realmId })).id)
		);
		const fake = failing();
		const queue = createEmbeddingQueue(db, fake.embedder);
		for (const id of ids) queue.enqueue(id);
		await queue.drain();
		expect(queue.size()).toBe(5);

		fake.heal();
		const late = (await seedLabour(db, { realmId })).id;
		queue.enqueue(late);
		await queue.drain();
		expect(queue.size()).toBe(0);
		expect((await vectorStatus(db, [late])).get(late)).toBe('current');

		error.mockClear();
		fake.breakAgain();
		queue.enqueue((await seedLabour(db, { realmId })).id);
		await queue.drain();
		expect(error).toHaveBeenCalledOnce();
	});

	describe('retry tick', () => {
		function manualTimers() {
			const scheduled: { run: () => void; ms: number; unref: ReturnType<typeof vi.fn> }[] = [];
			const cleared: unknown[] = [];
			return {
				scheduled,
				cleared,
				setTimer: (run: () => void, ms: number) => {
					const timer = { run, ms, unref: vi.fn() };
					scheduled.push(timer);
					return timer;
				},
				clearTimer: (timer: unknown) => cleared.push(timer)
			};
		}

		async function stopped(count = 25) {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const ids = await Promise.all(
				Array.from({ length: count }, async () => (await seedLabour(db, { realmId })).id)
			);
			const fake = failing();
			const timers = manualTimers();
			const queue = createEmbeddingQueue(db, fake.embedder, { retryAfterMs: 5, ...timers });
			return { ids, fake, timers, queue };
		}

		it('retries after 20 failures and drains the rest once the embedder recovers', async () => {
			const { ids, fake, timers, queue } = await stopped();
			for (const id of ids) queue.enqueue(id);
			await queue.drain();
			expect(queue.size()).toBe(5);
			expect(timers.scheduled).toHaveLength(1);
			expect(timers.scheduled[0].ms).toBe(5);

			fake.heal();
			timers.scheduled[0].run();
			await queue.drain();

			expect(queue.size()).toBe(0);
			const statuses = await Promise.all(
				ids.slice(20).map(async (id) => (await vectorStatus(db, [id])).get(id))
			);
			expect(statuses.every((status) => status === 'current')).toBe(true);
		});

		it('gives the retry a fresh run of attempts', async () => {
			const { ids, timers, queue } = await stopped(45);
			for (const id of ids) queue.enqueue(id);
			await queue.drain();
			expect(queue.size()).toBe(25);

			timers.scheduled[0].run();
			await queue.drain();

			expect(queue.size()).toBe(5);
			expect(timers.scheduled).toHaveLength(2);
		});

		it('never stacks timers and unrefs the one it holds', async () => {
			const { ids, timers, queue } = await stopped();
			for (const id of ids) queue.enqueue(id);
			await queue.drain();
			await queue.drain();

			expect(timers.scheduled).toHaveLength(1);
			expect(timers.scheduled[0].unref).toHaveBeenCalledOnce();
		});

		it('clears the timer when an enqueue restarts the queue', async () => {
			const { ids, fake, timers, queue } = await stopped();
			for (const id of ids) queue.enqueue(id);
			await queue.drain();

			fake.heal();
			queue.enqueue((await seedLabour(db, { realmId })).id);
			await queue.drain();

			expect(timers.cleared).toEqual([timers.scheduled[0]]);
			expect(queue.size()).toBe(0);
			expect(timers.scheduled).toHaveLength(1);
		});

		it('schedules nothing when the queue empties', async () => {
			const { fake, timers, queue } = await stopped();
			fake.heal();
			queue.enqueue((await seedLabour(db, { realmId })).id);
			await queue.drain();

			expect(timers.scheduled).toEqual([]);
		});

		it('leaves drain resolved while the timer is pending', async () => {
			const { ids, timers, queue } = await stopped();
			for (const id of ids) queue.enqueue(id);

			await expect(queue.drain()).resolves.toBeUndefined();
			expect(timers.scheduled).toHaveLength(1);
		});
	});
});

describe('the survey tool, guarding the Survey', () => {
	let registry: Registry;

	beforeEach(async () => {
		registry = toolRegistry(db, await seedHuman(db, 'ada'), 'http://sagas.test');
		registerSurveyTools(registry.tools);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('never embeds for a request it refuses', async () => {
		await seedLabour(db, { realmId });
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
		const a = await seedLabour(db, { realmId });
		await store(a.id);
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
		const a = await seedLabour(db, { realmId });
		await store(a.id);
		setEmbedder({
			model: MODEL_ID,
			embedDocument: async () => unit(1),
			embedQuery: () => new Promise<Float32Array>(() => {})
		});

		const timersBefore = vi.getTimerCount();
		const pending = registry.call('survey', {
			query: 'q',
			weights: { similarity: 1 },
			temperature: 0
		});
		// Real I/O runs first: the guard's timer exists only once the Survey reaches the query vector.
		while (vi.getTimerCount() <= timersBefore) await new Promise((r) => setImmediate(r));
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
			const boss = await seedLabour(db, {
				realmId,
				title: 'Tune boss fight difficulty',
				description: 'Adjust boss HP and damage so the encounter feels fair and combat feels punchy'
			});
			const icon = await seedLabour(db, {
				realmId,
				title: 'Fix inventory icon alignment',
				description: 'The sword icon sits two pixels left of the grid in the inventory panel'
			});
			const queue = createEmbeddingQueue(db, embedder);
			await enqueueStale(db, queue);
			await queue.drain();
			const queryVector = await embedder.embedQuery('improve combat feel for boss fights');
			const result = await survey(
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
