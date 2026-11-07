import { MODEL_ID } from '../../vectors/embedder.ts';
import { countCurrent, currentVectors } from '../../vectors/vectors.ts';
import type { Feature, FeatureContext } from './types.ts';

// Where unrelated text lands for bge-small; the product/agent-layer Scroll, Weights.
const FLOOR = 0.45;

const cache = new WeakMap<FeatureContext, Map<number, Float32Array>>();

// The candidates' current vectors, read once per Survey.
export async function embeddedOf(ctx: FeatureContext): Promise<Map<number, Float32Array>> {
	let vectors = cache.get(ctx);
	if (vectors === undefined) {
		vectors = await currentVectors(ctx.db, ctx.candidateIds, MODEL_ID);
		cache.set(ctx, vectors);
	}
	return vectors;
}

// Reuses the loaded vectors when the Survey read them; otherwise counts without reading blobs.
export async function embeddedCount(ctx: FeatureContext): Promise<number> {
	const loaded = cache.get(ctx);
	return loaded === undefined
		? await countCurrent(ctx.db, ctx.candidateIds, MODEL_ID)
		: loaded.size;
}

export const similarity: Feature = {
	name: 'similarity',
	needsQuery: true,
	async load(ctx) {
		const { candidates, queryVector } = ctx;
		const scores = new Map<number, number | null>(candidates.map((c) => [c.id, null]));
		if (queryVector === undefined) return scores;
		for (const [id, vector] of await embeddedOf(ctx)) {
			let dot = 0;
			for (let i = 0; i < vector.length; i++) dot += vector[i] * queryVector[i];
			scores.set(id, Math.min(1, Math.max(0, (dot - FLOOR) / (1 - FLOOR))));
		}
		return scores;
	}
};
