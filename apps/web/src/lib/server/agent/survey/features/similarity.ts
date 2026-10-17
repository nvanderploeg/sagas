import { MODEL_ID } from '../../vectors/embedder.ts';
import { currentVectors } from '../../vectors/vectors.ts';
import type { Feature, FeatureContext } from './types.ts';

// Where unrelated text lands for bge-small; docs/agent-layer.md, Weights.
const FLOOR = 0.45;

const cache = new WeakMap<FeatureContext, Map<number, Float32Array>>();

// The candidates' current vectors, read once per Survey.
export function embeddedOf(ctx: FeatureContext): Map<number, Float32Array> {
	let vectors = cache.get(ctx);
	if (vectors === undefined) {
		vectors = currentVectors(ctx.db, ctx.candidateIds, MODEL_ID);
		cache.set(ctx, vectors);
	}
	return vectors;
}

export const similarity: Feature = {
	name: 'similarity',
	needsQuery: true,
	load(ctx) {
		const { candidates, queryVector } = ctx;
		const scores = new Map<number, number | null>(candidates.map((c) => [c.id, null]));
		if (queryVector === undefined) return scores;
		for (const [id, vector] of embeddedOf(ctx)) {
			let dot = 0;
			for (let i = 0; i < vector.length; i++) dot += vector[i] * queryVector[i];
			scores.set(id, Math.min(1, Math.max(0, (dot - FLOOR) / (1 - FLOOR))));
		}
		return scores;
	}
};
