import { afterEach, describe, expect, it } from 'vitest';
import { publish, subscribe } from './bus.ts';
import type { SagasEvent } from './types.ts';

const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

const event = (seq: number) => ({ seq }) as SagasEvent;

describe('publish', () => {
	it('delivers to every listener in seq order when a listener publishes during delivery', () => {
		const first: number[] = [];
		const second: number[] = [];
		stops.push(
			subscribe((e) => {
				first.push(e.seq);
				if (e.seq === 1) publish(event(2));
			}),
			subscribe((e) => second.push(e.seq))
		);

		publish(event(1));

		expect(first).toEqual([1, 2]);
		expect(second).toEqual([1, 2]);
	});

	it('keeps delivering after a listener throws', () => {
		const seen: number[] = [];
		stops.push(
			subscribe(() => {
				throw new Error('boom');
			}),
			subscribe((e) => seen.push(e.seq))
		);
		const error = console.error;
		console.error = () => {};
		try {
			publish(event(1));
			publish(event(2));
		} finally {
			console.error = error;
		}

		expect(seen).toEqual([1, 2]);
	});
});
