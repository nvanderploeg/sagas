import type { Db, Handle } from '../../db/client.ts';
import { MODEL_ID, type Embedder } from './embedder.ts';
import { refreshEmbeddingInput } from './input.ts';
import { scanCurrent, statusAmong, writeVector } from './vectors.ts';

export type EmbeddingQueue = {
	enqueue(labourId: number): void;
	// Resolves once nothing is running: the queue is empty, or its worker stopped.
	drain(): Promise<void>;
	size(): number;
};

const LOGGED_FAILURES = 3;
const STOP_AFTER_FAILURES = 20;
const SCAN_CHUNK = 1000;

const models = new WeakMap<EmbeddingQueue, string>();

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createEmbeddingQueue(db: Db, embedder: Embedder): EmbeddingQueue {
	const pending = new Set<number>();
	let running: Promise<void> | null = null;
	// In a row; an embedding that succeeds resets it.
	let failures = 0;

	// Resolves true when it stored a vector.
	async function embedOne(labourId: number): Promise<boolean> {
		const job = db.transaction((tx) => {
			const refreshed = refreshEmbeddingInput(tx, labourId);
			if (refreshed === undefined) return undefined;
			const status = statusAmong(tx, JSON.stringify([labourId]), embedder.model);
			return status.get(labourId) === 'current' ? undefined : refreshed;
		});
		if (job === undefined) return false;
		const vector = await embedder.embedDocument(job.input);
		writeVector(db, labourId, embedder.model, job.hash, vector);
		return true;
	}

	function failed(labourId: number, error: unknown): void {
		failures += 1;
		if (failures <= LOGGED_FAILURES) {
			console.error(`sagas embedding of Labour ${labourId} failed`, error);
		} else if (failures === LOGGED_FAILURES + 1) {
			console.error(
				'sagas embeddings keep failing; further failures go unlogged until one succeeds'
			);
		}
		if (failures === STOP_AFTER_FAILURES) {
			console.warn(
				`sagas embeddings stopped after ${STOP_AFTER_FAILURES} failures in a row; ${pending.size} Labours wait for the next write`
			);
		}
	}

	async function work(): Promise<void> {
		// Starts after the caller's turn, so an enqueue never runs the embedder inline.
		await Promise.resolve();
		for (;;) {
			const next = pending.values().next();
			if (next.done) break;
			pending.delete(next.value);
			try {
				if (await embedOne(next.value)) failures = 0;
			} catch (error) {
				failed(next.value, error);
				if (failures >= STOP_AFTER_FAILURES) break;
			}
			// Yield to I/O between Labours, whatever the embedder does.
			await nextTurn();
		}
		running = null;
	}

	const queue: EmbeddingQueue = {
		enqueue(labourId) {
			pending.add(labourId);
			running ??= work();
		},
		async drain() {
			while (running !== null) await running;
		},
		size: () => pending.size
	};
	models.set(queue, embedder.model);
	return queue;
}

// Yields between chunks, so a large database never holds the event loop.
export async function enqueueStale(db: Handle, queue: EmbeddingQueue): Promise<number> {
	const model = models.get(queue) ?? MODEL_ID;
	let count = 0;
	let after = 0;
	for (;;) {
		const rows = scanCurrent(db, model, after, SCAN_CHUNK);
		if (rows.length === 0) return count;
		for (const row of rows) {
			if (row.current) continue;
			queue.enqueue(row.id);
			count += 1;
		}
		after = rows[rows.length - 1].id;
		await nextTurn();
	}
}
