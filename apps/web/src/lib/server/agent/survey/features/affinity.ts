import { sql } from 'drizzle-orm';
import { AFFINITY_LOUDNESS, inAttributes, keyOf, totalsOf } from '../../sentiment.ts';
import { heldOf } from './sentiment.ts';
import type { Feature } from './types.ts';

// In [-1, 1]; a candidate without data takes 0.
export const affinity: Feature = {
	name: 'affinity',
	load(ctx) {
		const held = heldOf(ctx);
		const attributeIds = new Set<number>();
		for (const entries of held.values()) {
			for (const entry of entries) attributeIds.add(entry.attributeId);
		}
		const scores = new Map<number, number | null>(ctx.candidates.map((c) => [c.id, 0]));
		if (attributeIds.size === 0) return scores;

		const strengths = new Map(
			totalsOf(
				ctx.db,
				sql`p.user_id = ${ctx.forUserId} AND ${inAttributes([...attributeIds])}`,
				ctx.now,
				'user'
			).map((total) => [
				keyOf(total.attributeId, total.member),
				{ v: total.volume / (total.volume + AFFINITY_LOUDNESS), mood: total.mood }
			])
		);
		if (strengths.size === 0) return scores;

		for (const { id } of ctx.candidates) {
			let calm = 1;
			let glad = 1;
			for (const entry of held.get(id) ?? []) {
				const strength = strengths.get(keyOf(entry.attributeId, entry.member));
				if (strength === undefined) continue;
				const reach = strength.v * entry.x;
				calm *= 1 - reach * Math.max(0, -strength.mood);
				glad *= 1 - reach * Math.max(0, strength.mood);
			}
			scores.set(id, calm - glad);
		}
		return scores;
	}
};
