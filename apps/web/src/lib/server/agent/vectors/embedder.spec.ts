import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serial } from './embedder';

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
