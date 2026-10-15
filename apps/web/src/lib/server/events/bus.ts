import type { SagasEvent } from './types.ts';

type Listener = (event: SagasEvent) => void;

const listeners = new Set<Listener>();
const queue: SagasEvent[] = [];
let delivering = false;

export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function subscriberCount(): number {
	return listeners.size;
}

// A publish made while delivering waits its turn, so every listener sees Events in seq order.
export function publish(event: SagasEvent): void {
	queue.push(event);
	if (delivering) return;
	delivering = true;
	try {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			for (const listener of [...listeners]) {
				try {
					listener(next);
				} catch (error) {
					console.error('sagas bus listener failed', error);
				}
			}
		}
	} finally {
		delivering = false;
	}
}
