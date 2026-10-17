import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

// Never downloads a model.
export async function loadEmbedder(
	dir: string,
	opts: { threads?: number } = {}
): Promise<Embedder | null> {
	const missing = FILES.filter((file) => !existsSync(join(dir, NAME, file)));
	if (missing.length > 0) {
		console.warn(`sagas embeddings off: ${missing.join(', ')} missing under ${join(dir, NAME)}`);
		return null;
	}
	try {
		// Importing it loads sharp and onnxruntime natively; only a server with the model pays.
		const { env, pipeline } = await import('@huggingface/transformers');
		env.allowRemoteModels = false;
		env.localModelPath = dir;
		env.useFSCache = false;
		const extractor = await pipeline('feature-extraction', NAME, {
			dtype: 'q8',
			session_options: { intraOpNumThreads: opts.threads ?? 2 }
		});
		// One text per call: batching pads and changes the vectors.
		let turn: Promise<unknown> = Promise.resolve();
		const embed = (text: string): Promise<Float32Array> => {
			const run = turn.then(async () => {
				const output = await extractor([text], { pooling: 'cls', normalize: true });
				return Float32Array.from(output.data as Float32Array);
			});
			turn = run.catch(() => undefined);
			return run;
		};
		return {
			model: MODEL_ID,
			embedDocument: embed,
			embedQuery: (text) => embed(QUERY_PREFIX + text)
		};
	} catch (error) {
		console.warn('sagas embeddings off: the model failed to load', error);
		return null;
	}
}
