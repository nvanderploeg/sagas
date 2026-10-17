export { MODEL_ID } from './embedder.ts';
export { embeddingTextChanged, setEmbeddingQueue } from './hook.ts';
export { refreshEmbeddingInput } from './input.ts';
export { createEmbeddingQueue, enqueueStale, type EmbeddingQueue } from './queue.ts';
export { readVectors, vectorStatus, writeVector, type VectorStatus } from './vectors.ts';
