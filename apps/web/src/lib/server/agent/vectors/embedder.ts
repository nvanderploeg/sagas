import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const NAME = 'Xenova/bge-small-en-v1.5';
// Vectors from two revisions don't compare: change this only together with scripts/fetch-model.js.
const REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
const FILES = [
	'config.json',
	'tokenizer.json',
	'tokenizer_config.json',
	'onnx/model_quantized.onnx'
];
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const CALL_TIMEOUT_MS = 30_000;

export const MODEL_ID = `${NAME}@${REVISION}`;

export type Embedder = {
	model: string;
	embedDocument(text: string): Promise<Float32Array>;
	embedQuery(text: string): Promise<Float32Array>;
};

let current: Embedder | null = null;

export function getEmbedder(): Embedder | null {
	return current;
}

export function setEmbedder(embedder: Embedder | null): void {
	current = embedder;
}

// Calls run one at a time in arrival order. A call past timeoutMs rejects and frees the
// next one; its late result is dropped.
export function serial<A, T>(
	run: (arg: A) => Promise<T>,
	{ timeoutMs }: { timeoutMs: number }
): (arg: A) => Promise<T> {
	let turn: Promise<unknown> = Promise.resolve();
	return (arg) => {
		const call = turn.then(
			() =>
				new Promise<T>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`embedding timed out after ${timeoutMs} ms`)),
						timeoutMs
					);
					run(arg).then(
						(value) => {
							clearTimeout(timer);
							resolve(value);
						},
						(error) => {
							clearTimeout(timer);
							reject(error);
						}
					);
				})
		);
		turn = call.catch(() => undefined);
		return call;
	};
}

// The worker is plain JS shipped beside the built server (Dockerfile copies server/); the
// bundler never sees it.
const DEFAULT_WORKER = resolve(process.cwd(), 'server/embed-worker.js');

export type LoadedEmbedder = Embedder & { dispose(): Promise<void> };

type Reply = { id: number; vector?: Float32Array; error?: string };

// Never downloads a model.
export async function loadEmbedder(
	dir: string,
	opts: { threads?: number; timeoutMs?: number; workerPath?: string } = {}
): Promise<LoadedEmbedder | null> {
	const missing = FILES.filter((file) => !existsSync(join(dir, NAME, file)));
	if (missing.length > 0) {
		console.warn(`sagas embeddings off: ${missing.join(', ')} missing under ${join(dir, NAME)}`);
		return null;
	}
	const worker = new Worker(opts.workerPath ?? DEFAULT_WORKER, {
		workerData: { dir, name: NAME, threads: opts.threads ?? 2 }
	});
	const pending = new Map<number, { resolve(v: Float32Array): void; reject(e: Error): void }>();
	let dead: Error | null = null;
	let nextId = 0;

	const fail = (error: Error) => {
		dead ??= error;
		for (const call of pending.values()) call.reject(error);
		pending.clear();
	};

	const ready = new Promise<boolean>((done) => {
		worker.on('message', (message: Reply & { ready?: boolean; failed?: string }) => {
			if (message.ready) return done(true);
			if (message.failed !== undefined) {
				console.warn('sagas embeddings off: the model failed to load', message.failed);
				return done(false);
			}
			const call = pending.get(message.id);
			if (!call) return;
			pending.delete(message.id);
			if (message.vector) call.resolve(message.vector);
			else call.reject(new Error(message.error ?? 'embedding failed'));
		});
		worker.on('error', (error) => {
			console.warn('sagas embeddings off: the embedding worker failed', error);
			fail(error);
			done(false);
		});
		worker.on('exit', (code) => {
			fail(new Error(`embedding worker exited (code ${code})`));
			done(false);
		});
	});

	if (!(await ready)) {
		await worker.terminate();
		return null;
	}
	worker.unref();

	const embed = serial(
		(text: string) =>
			new Promise<Float32Array>((resolve, reject) => {
				if (dead) return reject(dead);
				const id = nextId++;
				pending.set(id, { resolve, reject });
				worker.postMessage({ id, text });
			}),
		{ timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS }
	);
	return {
		model: MODEL_ID,
		embedDocument: embed,
		embedQuery: (text) => embed(QUERY_PREFIX + text),
		async dispose() {
			fail(new Error('embedder disposed'));
			await worker.terminate();
		}
	};
}
