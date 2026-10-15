import type { WorkloadEvent } from './types.ts';

type Listener = (event: WorkloadEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function subscriberCount(): number {
	return listeners.size;
}

export function publish(event: WorkloadEvent): void {
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch (error) {
			console.error('workload bus listener failed', error);
		}
	}
}
