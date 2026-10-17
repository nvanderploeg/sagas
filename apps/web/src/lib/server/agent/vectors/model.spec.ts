import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEmbedder, type Embedder } from './embedder.ts';

const MODEL_ID = 'Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3';
const MODEL_FILES = [
	'Xenova/bge-small-en-v1.5/config.json',
	'Xenova/bge-small-en-v1.5/tokenizer.json',
	'Xenova/bge-small-en-v1.5/tokenizer_config.json',
	'Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx'
];

const modelDir = resolve(process.cwd(), process.env.EMBEDDING_MODEL_DIR ?? 'models');
const filesPresent = MODEL_FILES.every((file) => existsSync(join(modelDir, file)));

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i], 0);

const QUERY = 'improve combat feel for boss fights';
const RELEVANT = [
	'Bosses feel like bullet sponges\n\nPlaytesters say the dragon fight drags on forever.',
	'Telegraph feedback pass\n\nClearer boss wind-ups give players decision moments.'
];
const UNRELATED = [
	'Inventory UI\n\nSort button overlaps the stack count on small screens.',
	'OAuth token endpoint\n\nCode exchange and refresh.'
];

describe.skipIf(!filesPresent)('the shipped model', () => {
	let embedder: Embedder;

	beforeAll(async () => {
		const loaded = await loadEmbedder(modelDir);
		if (loaded === null) throw new Error(`loadEmbedder returned null for ${modelDir}`);
		embedder = loaded;
	}, 120_000);

	it('identifies itself by the pinned model id', () => {
		expect(embedder.model).toBe(MODEL_ID);
	});

	it('embeds a document as 384 values of unit length', async () => {
		const vector = await embedder.embedDocument('Bosses feel like bullet sponges');

		expect(vector).toBeInstanceOf(Float32Array);
		expect(vector).toHaveLength(384);
		expect(Math.sqrt(dot(vector, vector))).toBeCloseTo(1, 4);
	});

	it('embeds a query as 384 values of unit length', async () => {
		const vector = await embedder.embedQuery(QUERY);

		expect(vector).toBeInstanceOf(Float32Array);
		expect(vector).toHaveLength(384);
		expect(Math.sqrt(dot(vector, vector))).toBeCloseTo(1, 4);
	});

	it('embeds the same document to the same vector every time', async () => {
		const first = await embedder.embedDocument(RELEVANT[0]);
		const second = await embedder.embedDocument(RELEVANT[0]);

		expect(Array.from(second)).toEqual(Array.from(first));
	});

	it('embeds a query differently from the same text as a document', async () => {
		const asQuery = await embedder.embedQuery('boss fights');
		const asDocument = await embedder.embedDocument('boss fights');

		expect(Array.from(asQuery)).not.toEqual(Array.from(asDocument));
	});

	it('ranks documents about the ask above documents about something else', async () => {
		const query = await embedder.embedQuery(QUERY);
		const relevant = await Promise.all(RELEVANT.map((text) => embedder.embedDocument(text)));
		const unrelated = await Promise.all(UNRELATED.map((text) => embedder.embedDocument(text)));

		const worstRelevant = Math.min(...relevant.map((vector) => dot(query, vector)));
		const bestUnrelated = Math.max(...unrelated.map((vector) => dot(query, vector)));

		expect(worstRelevant).toBeGreaterThan(bestUnrelated);
	});
});

describe('loadEmbedder without a usable model', () => {
	const made: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir() {
		const dir = mkdtempSync(join(tmpdir(), 'sagas-model-'));
		made.push(dir);
		return dir;
	}

	function layout(dir: string, files: string[], content = 'garbage') {
		for (const file of files) {
			const path = join(dir, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
	}

	it('resolves null for an empty directory, with one warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(loadEmbedder(tempDir())).resolves.toBeNull();

		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('resolves null for a directory that does not exist', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(loadEmbedder(join(tempDir(), 'missing'))).resolves.toBeNull();

		expect(warn).toHaveBeenCalledTimes(1);
	});

	it.each(MODEL_FILES)('resolves null when %s is the one file missing', async (missing) => {
		const dir = tempDir();
		layout(
			dir,
			MODEL_FILES.filter((file) => file !== missing)
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(loadEmbedder(dir)).resolves.toBeNull();

		expect(warn).toHaveBeenCalledTimes(1);
	});

	it(
		'resolves null, with one warning, when the files are present but cannot be loaded',
		{ timeout: 60_000 },
		async () => {
			const dir = tempDir();
			layout(dir, MODEL_FILES);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await expect(loadEmbedder(dir)).resolves.toBeNull();

			expect(warn).toHaveBeenCalledTimes(1);
		}
	);
});
