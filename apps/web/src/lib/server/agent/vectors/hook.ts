import type { EmbeddingQueue } from './queue.ts';

let current: EmbeddingQueue | null = null;

export function setEmbeddingQueue(queue: EmbeddingQueue | null): void {
	current = queue;
}

export function embeddingTextChanged(labourId: number): void {
	current?.enqueue(labourId);
}
