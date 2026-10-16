import { heaviestPulses, inKeys, keyOf, type PulseView } from '../sentiment.ts';
import type { Candidate } from './candidates.ts';
import { loadOf } from './features/sentiment.ts';
import type { FeatureContext } from './features/types.ts';

export type SurveySentiment = {
	realmId: number;
	key: string;
	volume: number;
	mood: number;
	pulses: PulseView[];
};

export const SENTIMENT_KEYS_MAX = 10;
export const SENTIMENT_PULSES = 2;

// Loudest first.
export function sentimentBlock(ctx: FeatureContext, shown: Candidate[]): SurveySentiment[] {
	if (shown.length === 0) return [];
	const { held, strengths } = loadOf(ctx);
	const realmKeys = new Map(shown.map((candidate) => [candidate.realmId, candidate.realmKey]));

	const found = new Map<
		string,
		{ realmId: number; realmKey: string; attributeId: number; member: string | null; key: string }
	>();
	for (const { id: labourId } of shown) {
		for (const entry of held.get(labourId) ?? []) {
			const id = keyOf(entry.attributeId, entry.member);
			if (found.has(id) || (strengths.get(id)?.volume ?? 0) <= 0) continue;
			found.set(id, {
				realmId: entry.realmId,
				realmKey: realmKeys.get(entry.realmId)!,
				attributeId: entry.attributeId,
				member: entry.member,
				key: entry.member === null ? entry.attribute : `${entry.attribute}:${entry.member}`
			});
		}
	}

	const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	const top = [...found].sort(
		([idA, a], [idB, b]) =>
			strengths.get(idB)!.volume - strengths.get(idA)!.volume ||
			order(a.realmKey, b.realmKey) ||
			order(a.key, b.key)
	);
	const chosen = top.slice(0, SENTIMENT_KEYS_MAX);
	const pulses = heaviestPulses(
		ctx.db,
		inKeys(chosen.map(([, entry]) => entry)),
		SENTIMENT_PULSES,
		ctx.now
	);
	return chosen.map(([id, entry]) => ({
		realmId: entry.realmId,
		key: entry.key,
		volume: strengths.get(id)!.volume,
		mood: strengths.get(id)!.mood,
		pulses: pulses.get(id) ?? []
	}));
}
