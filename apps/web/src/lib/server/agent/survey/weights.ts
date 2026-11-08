import { sql } from 'drizzle-orm';
import type { Handle } from '../../db/client.ts';
import { attributes } from '../../db/schema.ts';
import type { TagsSpec } from '../attributes.ts';
import type { Candidate } from './candidates.ts';
import { FEATURES, LATER_FEATURES, type FeatureContext } from './features/index.ts';
import { loadAttributeFeatures, MISSING, type AttributeWeight } from './features/attributes.ts';
import { intList } from '#lib/server/db/lists.ts';

export type Applied = {
	key: string;
	weight: number;
	// Labour id to feature value; a candidate left out takes 0.
	values: Map<number, number>;
	// Candidates that took the missing-data value.
	missing: number;
};

// Keys with no feature behind them, whatever the surveyed Realms hold.
const UNSCORED = new Set(['rank', 'priority']);

export type Vocabulary = {
	// Every Attribute key of the surveyed Realms.
	attributeKeys: Set<string>;
	scaleKeys: Set<string>;
	// `attr:member` of every tags Attribute.
	memberKeys: Set<string>;
};

export async function readVocabulary(tx: Handle, realmIds: number[]): Promise<Vocabulary> {
	const vocabulary: Vocabulary = {
		attributeKeys: new Set(),
		scaleKeys: new Set(),
		memberKeys: new Set()
	};
	const rows = await tx
		.select({ key: attributes.key, kind: attributes.kind, spec: attributes.spec })
		.from(attributes)
		.where(sql`${attributes.realmId} IN ${intList(realmIds)}`);
	for (const { key, kind, spec } of rows) {
		vocabulary.attributeKeys.add(key);
		if (kind === 'scale') vocabulary.scaleKeys.add(key);
		if (kind === 'tags') {
			for (const member of (spec as TagsSpec).members)
				vocabulary.memberKeys.add(`${key}:${member.key}`);
		}
	}
	return vocabulary;
}

// null is missing data and takes MISSING.
function fill(
	loaded: Map<number, number | null>,
	candidates: Candidate[]
): Pick<Applied, 'values' | 'missing'> {
	const values = new Map<number, number>();
	let missing = 0;
	for (const { id } of candidates) {
		const value = loaded.get(id);
		if (value === undefined) continue;
		if (value === null) {
			values.set(id, MISSING);
			missing += 1;
		} else {
			values.set(id, value);
		}
	}
	return { values, missing };
}

// Applied weights keep the order of `weights`.
export async function applyWeights(
	context: FeatureContext,
	weights: Record<string, number>,
	vocabulary: Vocabulary
): Promise<{ applied: Applied[]; ignored: string[] }> {
	const ignored: string[] = [];
	const slots: (Applied | AttributeWeight)[] = [];

	for (const key of Object.keys(weights)) {
		const feature = Object.hasOwn(FEATURES, key) ? FEATURES[key] : undefined;
		if (feature !== undefined) {
			if (feature.needsQuery && context.query === undefined) ignored.push(key);
			else
				slots.push({
					key,
					weight: weights[key],
					...fill(await feature.load(context), context.candidates)
				});
		} else if (LATER_FEATURES.includes(key) || UNSCORED.has(key)) {
			ignored.push(key);
		} else if (vocabulary.scaleKeys.has(key)) {
			slots.push({ key, attribute: key });
		} else if (vocabulary.memberKeys.has(key)) {
			const [attribute, member] = key.split(':');
			slots.push({ key, attribute, member });
		} else {
			ignored.push(key);
		}
	}

	const loaded = await loadAttributeFeatures(
		context.db,
		context.candidates,
		context.candidateIds,
		slots.filter((slot): slot is AttributeWeight => 'attribute' in slot)
	);
	const applied = slots.map((slot) => {
		if (!('attribute' in slot)) return slot;
		const { values, missing } = loaded.get(slot.key)!;
		return { key: slot.key, weight: weights[slot.key], values, missing };
	});
	return { applied, ignored };
}
