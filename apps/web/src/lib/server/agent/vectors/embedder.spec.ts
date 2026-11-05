import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEmbedder, serial } from './embedder';

describe('serial', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('rejects a hung call after the timeout and still runs the next call', async () => {
		const run = vi.fn((n: number) =>
			n === 1 ? new Promise<number>(() => {}) : Promise.resolve(n)
		);
		const call = serial(run, { timeoutMs: 1000 });
		const hung = call(1);
		const hungResult = expect(hung).rejects.toThrow(/timed out/);
		const next = call(2);
		await vi.advanceTimersByTimeAsync(1000);
		await hungResult;
		await expect(next).resolves.toBe(2);
	});

	it('ignores the late result of a timed-out call', async () => {
		let late!: (value: number) => void;
		const call = serial(
			(n: number) => (n === 1 ? new Promise<number>((r) => (late = r)) : Promise.resolve(n)),
			{ timeoutMs: 10 }
		);
		const hung = expect(call(1)).rejects.toThrow(/timed out/);
		await vi.advanceTimersByTimeAsync(10);
		await hung;
		late(99);
		await expect(call(2)).resolves.toBe(2);
	});

	it('runs calls one at a time in order', async () => {
		const log: string[] = [];
		const call = serial(
			async (n: number) => {
				log.push(`start ${n}`);
				await new Promise((r) => setTimeout(r, 5));
				log.push(`end ${n}`);
				return n;
			},
			{ timeoutMs: 1000 }
		);
		const all = Promise.all([call(1), call(2), call(3)]);
		await vi.advanceTimersByTimeAsync(20);
		await expect(all).resolves.toEqual([1, 2, 3]);
		expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
	});

	it('clears the timer when a call settles', async () => {
		const call = serial(async (n: number) => n, { timeoutMs: 1000 });
		await call(1);
		expect(vi.getTimerCount()).toBe(0);
		const failing = serial(() => Promise.reject(new Error('x')), { timeoutMs: 1000 });
		await expect(failing(1)).rejects.toThrow('x');
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('loadEmbedder worker protocol', () => {
	const worker = fileURLToPath(new URL('./testdata/fake-embed-worker.js', import.meta.url));
	const made: string[] = [];
	const modelDir = (mode: string) => {
		const dir = join(mkdtempSync(join(tmpdir(), 'embed-')), mode);
		made.push(dir);
		for (const file of [
			'config.json',
			'tokenizer.json',
			'tokenizer_config.json',
			'onnx/model_quantized.onnx'
		]) {
			mkdirSync(dirname(join(dir, 'Xenova/bge-small-en-v1.5', file)), { recursive: true });
			writeFileSync(join(dir, 'Xenova/bge-small-en-v1.5', file), '');
		}
		return dir;
	};
	afterEach(() => vi.restoreAllMocks());

	it('completes the ready handshake and round-trips vectors', async () => {
		const embedder = await loadEmbedder(modelDir('ok'), { workerPath: worker, threads: 3 });
		expect(embedder).not.toBeNull();
		expect(Array.from(await embedder!.embedDocument('abcd'))).toEqual([4, 3]);
		const query = await embedder!.embedQuery('x');
		expect(query[0]).toBe('Represent this sentence for searching relevant passages: x'.length);
		await embedder!.dispose();
	});

	it('rejects a call whose reply is an error', async () => {
		const embedder = await loadEmbedder(modelDir('ok'), { workerPath: worker });
		await expect(embedder!.embedDocument('bad')).rejects.toThrow('nope');
		await expect(embedder!.embedDocument('ok')).resolves.toBeInstanceOf(Float32Array);
		await embedder!.dispose();
	});

	it('rejects pending and later calls when the worker exits', async () => {
		const embedder = await loadEmbedder(modelDir('ok'), { workerPath: worker });
		await expect(embedder!.embedDocument('die')).rejects.toThrow(/exited/);
		await expect(embedder!.embedDocument('after')).rejects.toThrow(/exited/);
	});

	it('rejects a hung call after the timeout', async () => {
		const embedder = await loadEmbedder(modelDir('ok'), { workerPath: worker, timeoutMs: 50 });
		await expect(embedder!.embedDocument('hang')).rejects.toThrow(/timed out/);
		await embedder!.dispose();
	});

	it('returns null when the worker reports a load failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await loadEmbedder(modelDir('fail'), { workerPath: worker })).toBeNull();
		expect(warn).toHaveBeenCalled();
	});

	it('returns null when the worker exits before ready', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await loadEmbedder(modelDir('crash'), { workerPath: worker })).toBeNull();
	});
});
